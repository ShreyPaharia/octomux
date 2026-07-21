import path from 'path';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { probeBinary, brewInstall, hasBrew } from './binary-check.js';
import type { BinaryDep } from './startup.js';
import { getSettings, type OctomuxSettings, type EditorChoice } from './settings.js';
import { ensureGithubLogin } from './github-login.js';
import { syncLazyVimPlugins } from './startup.js';
const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type SetupItemStatus = 'ok' | 'missing' | 'outdated' | 'unconfigured' | 'optional_missing';

export type SetupItemCategory = 'required' | 'recommended' | 'optional';

export interface SetupInstallAction {
  kind: 'brew' | 'copy' | 'template' | 'sync' | 'shell';
  id: string;
  label: string;
}

export interface SetupItem {
  id: string;
  label: string;
  category: SetupItemCategory;
  status: SetupItemStatus;
  version?: string;
  detail?: string;
  install?: SetupInstallAction;
  configureUrl?: string;
  docsUrl?: string;
}

export interface SetupStatusResponse {
  items: SetupItem[];
  summary: {
    ready: boolean;
    blockerCount: number;
    attentionCount: number;
  };
  platform: string;
  hasBrew: boolean;
}

/**
 * `shellInstall` is a fixed POSIX command line used to install a dependency that
 * has no Homebrew package (e.g. the coding-agent CLIs). It is run verbatim via
 * `bash -lc` from `runSetupInstall` and is NEVER built from user input — the only
 * source is this static table. Omit it (or run on Windows) to fall back to the docs
 * link.
 */
type SetupBinaryDep = BinaryDep & {
  id: string;
  category: SetupItemCategory;
  shellInstall?: string;
};

const BINARY_DEPS: SetupBinaryDep[] = [
  { id: 'tmux', cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux', category: 'required' },
  { id: 'git', cmd: 'git', checkArgs: ['--version'], brewPkg: 'git', category: 'required' },
  {
    id: 'claude',
    cmd: 'claude',
    checkArgs: ['--version'],
    name: 'Claude Code CLI',
    installUrl: 'https://code.claude.com/docs/en/setup',
    shellInstall: 'curl -fsSL https://claude.ai/install.sh | bash',
    category: 'recommended',
  },
  {
    id: 'cursor-agent',
    cmd: 'cursor-agent',
    checkArgs: ['--version'],
    name: 'Cursor CLI',
    installUrl: 'https://cursor.com/docs/cli',
    shellInstall: 'curl https://cursor.com/install -fsS | bash',
    category: 'optional',
  },
];

const EDITOR_DEPS: Record<EditorChoice, BinaryDep & { displayName: string }> = {
  nvim: {
    cmd: 'nvim',
    checkArgs: ['--version'],
    brewPkg: 'neovim',
    displayName: 'Neovim',
  },
  cursor: {
    cmd: 'cursor',
    checkArgs: ['--version'],
    displayName: 'Cursor IDE',
    installUrl: 'https://cursor.com/',
  },
  vscode: {
    cmd: 'code',
    checkArgs: ['--version'],
    displayName: 'VS Code',
    installUrl: 'https://code.visualstudio.com/',
  },
};

function packageRoot(): string {
  return path.resolve(__dirname, '..');
}

/**
 * Pick an install action for a missing binary dep: prefer Homebrew on macOS, then a
 * fixed shell installer on any POSIX platform. Returns undefined when neither applies
 * (the UI then shows only the docs link).
 */
function binaryInstallAction(dep: SetupBinaryDep): SetupInstallAction | undefined {
  const name = dep.name || dep.cmd;
  if (dep.brewPkg && hasBrew() && process.platform === 'darwin') {
    return { kind: 'brew', id: dep.id, label: `Install ${name} (Homebrew)` };
  }
  if (dep.shellInstall && process.platform !== 'win32') {
    return { kind: 'shell', id: dep.id, label: `Install ${name}` };
  }
  return undefined;
}

function defaultsConfigured(settings: OctomuxSettings): boolean {
  return Boolean(settings.defaultBaseBranch?.trim());
}

function buildEditorItem(choice: EditorChoice): SetupItem {
  const dep = EDITOR_DEPS[choice];
  const probe = probeBinary(dep);
  let status: SetupItemStatus = probe.ok ? 'ok' : 'missing';
  let detail: string | undefined;

  if (choice === 'nvim' && probe.ok) {
    try {
      const verOut = execFileSync('nvim', ['--version'], { encoding: 'utf8' });
      const match = verOut.match(/(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major === 0 && minor < 10) {
          status = 'outdated';
          detail = `Found ${match[0]} — need >= 0.10`;
        }
      }
    } catch {
      // ignore
    }
  }

  const install =
    status !== 'ok' && dep.brewPkg && hasBrew() && process.platform === 'darwin'
      ? { kind: 'brew' as const, id: 'editor', label: `Install ${dep.displayName} (Homebrew)` }
      : undefined;

  return {
    id: 'editor',
    label: `Editor: ${dep.displayName}`,
    category: 'recommended',
    status,
    version: probe.version,
    detail:
      detail ??
      (status === 'missing' ? `Configured editor "${choice}" not found on PATH` : undefined),
    install,
    docsUrl: dep.installUrl,
    configureUrl: '/settings',
  };
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  const settings = await getSettings();
  const items: SetupItem[] = [];

  for (const dep of BINARY_DEPS) {
    const probe = probeBinary(dep);
    const status: SetupItemStatus = probe.ok
      ? 'ok'
      : dep.category === 'optional'
        ? 'optional_missing'
        : 'missing';

    const install = status !== 'ok' ? binaryInstallAction(dep) : undefined;

    items.push({
      id: dep.id,
      label: dep.name || dep.cmd,
      category: dep.category,
      status,
      version: probe.version,
      install,
      docsUrl: dep.installUrl,
    });
  }

  items.push(buildEditorItem(settings.editor));

  const ghProbe = probeBinary({ cmd: 'gh', checkArgs: ['--version'] });
  let ghStatus: SetupItemStatus = ghProbe.ok ? 'unconfigured' : 'missing';
  let ghDetail: string | undefined = ghProbe.ok ? undefined : 'Install GitHub CLI';
  if (ghProbe.ok) {
    try {
      await execFile('gh', ['auth', 'status']);
      ghStatus = 'ok';
      ghDetail = undefined;
    } catch {
      ghStatus = 'unconfigured';
      ghDetail = 'Run: gh auth login';
    }
  }
  items.push({
    id: 'gh',
    label: 'GitHub CLI',
    category: 'optional',
    status: ghStatus,
    version: ghProbe.version,
    detail: ghDetail,
    docsUrl: 'https://cli.github.com/',
    install:
      hasBrew() && process.platform === 'darwin' && ghStatus === 'missing'
        ? { kind: 'brew', id: 'gh', label: 'Install gh (Homebrew)' }
        : undefined,
  });

  const githubLogin = await ensureGithubLogin();
  if (ghStatus === 'ok') {
    items.push({
      id: 'github-login',
      label: 'GitHub account (cached)',
      category: 'optional',
      status: githubLogin ? 'ok' : 'unconfigured',
      version: githubLogin ?? undefined,
      detail: githubLogin ? undefined : 'gh auth login to enable PR reviewer polling',
    });
  }

  items.push({
    id: 'defaults',
    label: 'Task defaults',
    category: 'recommended',
    status: defaultsConfigured(settings) ? 'ok' : 'unconfigured',
    detail: settings.defaultBaseBranch
      ? `Base branch: ${settings.defaultBaseBranch}`
      : 'Set default base branch (and optional Jira defaults)',
  });

  const blockerCount = items.filter(
    (i) => i.category === 'required' && (i.status === 'missing' || i.status === 'outdated'),
  ).length;
  const attentionCount = items.filter(
    (i) =>
      i.status === 'missing' ||
      i.status === 'outdated' ||
      i.status === 'unconfigured' ||
      i.status === 'optional_missing',
  ).length;

  return {
    items,
    summary: {
      ready: blockerCount === 0,
      blockerCount,
      attentionCount,
    },
    platform: process.platform,
    hasBrew: hasBrew(),
  };
}

const INSTALL_ALLOWLIST = new Set([
  'tmux',
  'git',
  'claude',
  'cursor-agent',
  'editor',
  'gh',
  'lazyvim-sync',
]);

export async function runSetupInstall(id: string): Promise<{ ok: boolean; message: string }> {
  if (!INSTALL_ALLOWLIST.has(id)) {
    throw new Error(`Install not allowed for: ${id}`);
  }

  const shellDep = BINARY_DEPS.find((d) => d.id === id && d.shellInstall);
  if (shellDep?.shellInstall) {
    if (process.platform === 'win32') {
      return {
        ok: false,
        message: `Install ${shellDep.name || shellDep.cmd} manually${shellDep.installUrl ? `: ${shellDep.installUrl}` : ''}.`,
      };
    }
    try {
      execFileSync('bash', ['-lc', shellDep.shellInstall], { stdio: 'inherit' });
    } catch {
      // fall through to the re-probe below; a failed installer still gets a clear message
    }
    const ok = probeBinary({ cmd: shellDep.cmd, checkArgs: shellDep.checkArgs }).ok;
    return ok
      ? { ok: true, message: `Installed ${shellDep.name || shellDep.cmd}` }
      : {
          ok: false,
          message: `Could not install ${shellDep.name || shellDep.cmd}. Install manually${shellDep.installUrl ? `: ${shellDep.installUrl}` : ''}.`,
        };
  }

  if (id === 'lazyvim-sync') {
    syncLazyVimPlugins(packageRoot());
    return { ok: true, message: 'LazyVim plugin sync finished (or was already up to date)' };
  }

  if (id === 'gh') {
    const ok = brewInstall('gh', { cmd: 'gh', checkArgs: ['--version'] });
    return ok
      ? { ok: true, message: 'Installed GitHub CLI' }
      : { ok: false, message: 'Could not install gh via Homebrew' };
  }

  if (id === 'editor') {
    const settings = await getSettings();
    const editorDep = EDITOR_DEPS[settings.editor];
    if (!editorDep.brewPkg) {
      return {
        ok: false,
        message: `Install ${editorDep.displayName} manually${editorDep.installUrl ? `: ${editorDep.installUrl}` : ''}.`,
      };
    }
    const ok = brewInstall(editorDep.brewPkg, {
      cmd: editorDep.cmd,
      checkArgs: editorDep.checkArgs,
    });
    return ok
      ? { ok: true, message: `Installed ${editorDep.displayName}` }
      : {
          ok: false,
          message: `Could not install ${editorDep.displayName}${editorDep.installUrl ? `: ${editorDep.installUrl}` : ''}.`,
        };
  }

  const dep = BINARY_DEPS.find((d) => d.id === id);
  if (dep?.brewPkg) {
    const ok = brewInstall(dep.brewPkg, { cmd: dep.cmd, checkArgs: dep.checkArgs });
    if (!ok) {
      return {
        ok: false,
        message: `Could not install ${dep.name || dep.cmd}. Install manually${dep.installUrl ? `: ${dep.installUrl}` : ''}.`,
      };
    }
    return { ok: true, message: `Installed ${dep.name || dep.cmd}` };
  }

  throw new Error(`Unknown install id: ${id}`);
}

export async function applyRecommendedDefaults(): Promise<OctomuxSettings> {
  const { updateSettings } = await import('./settings.js');
  const current = await getSettings();
  const patch: Partial<OctomuxSettings> = {};

  if (!current.defaultBaseBranch?.trim()) {
    patch.defaultBaseBranch = await detectDefaultBaseBranch();
  }

  if (!current.defaultHarnessId) {
    if (probeBinary({ cmd: 'claude', checkArgs: ['--version'] }).ok) {
      patch.defaultHarnessId = 'claude-code';
    } else if (probeBinary({ cmd: 'cursor-agent', checkArgs: ['--version'] }).ok) {
      patch.defaultHarnessId = 'cursor';
    }
  }

  if (Object.keys(patch).length === 0) {
    return current;
  }

  return updateSettings(patch);
}

async function detectDefaultBaseBranch(): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const ref = stdout.trim();
    const match = ref.match(/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    // fall through
  }
  return 'main';
}
