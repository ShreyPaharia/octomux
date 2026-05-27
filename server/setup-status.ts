import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile as execFileCb, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { probeBinary, brewInstall, hasBrew } from './binary-check.js';
import type { BinaryDep } from './startup.js';
import { getSettings, type OctomuxSettings, type EditorChoice } from './settings.js';
import { listIntegrations } from './integrations/store.js';
import { ensureGithubLogin } from './github-login.js';
import {
  isHookTemplateInstalled,
  listHookTemplates,
  installHookTemplate,
} from './hooks-install.js';
import { syncLazyVimPlugins } from './startup.js';
const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type SetupItemStatus = 'ok' | 'missing' | 'outdated' | 'unconfigured' | 'optional_missing';

export type SetupItemCategory = 'required' | 'recommended' | 'optional';

export interface SetupInstallAction {
  kind: 'brew' | 'copy' | 'template' | 'sync';
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

const BINARY_DEPS: Array<BinaryDep & { id: string; category: SetupItemCategory }> = [
  { id: 'tmux', cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux', category: 'required' },
  { id: 'git', cmd: 'git', checkArgs: ['--version'], brewPkg: 'git', category: 'required' },
  {
    id: 'claude',
    cmd: 'claude',
    checkArgs: ['--version'],
    name: 'Claude Code CLI',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    category: 'recommended',
  },
  {
    id: 'cursor-agent',
    cmd: 'cursor-agent',
    checkArgs: ['--version'],
    name: 'Cursor CLI',
    installUrl: 'https://cursor.com/docs/cli',
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

function bundledSkillsDir(): string {
  return path.join(packageRoot(), 'skills');
}

function claudeSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

function missingBundledSkills(): string[] {
  const src = bundledSkillsDir();
  if (!fs.existsSync(src)) return [];
  const target = claudeSkillsDir();
  const missing: string[] = [];
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    try {
      if (!fs.statSync(srcPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!fs.existsSync(path.join(target, name))) missing.push(name);
  }
  return missing;
}

function jiraEnvConfigured(): boolean {
  return Boolean(
    process.env.JIRA_BASE_URL?.trim() &&
    process.env.JIRA_EMAIL?.trim() &&
    process.env.JIRA_TOKEN?.trim(),
  );
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

    const install =
      status !== 'ok' && dep.brewPkg && hasBrew() && process.platform === 'darwin'
        ? { kind: 'brew' as const, id: dep.id, label: `Install ${dep.name || dep.cmd} (Homebrew)` }
        : undefined;

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

  const missingSkills = missingBundledSkills();
  items.push({
    id: 'skills',
    label: 'Octomux skills (Claude Code)',
    category: 'recommended',
    status: missingSkills.length === 0 ? 'ok' : 'missing',
    detail: missingSkills.length ? `Missing: ${missingSkills.join(', ')}` : undefined,
    install: missingSkills.length
      ? { kind: 'copy', id: 'skills', label: 'Install bundled skills' }
      : undefined,
  });

  const jiraHookInstalled = isHookTemplateInstalled('jira-status');
  items.push({
    id: 'jira-status-hook',
    label: 'jira-status hook',
    category: 'optional',
    status: jiraHookInstalled ? 'ok' : 'optional_missing',
    install: jiraHookInstalled
      ? undefined
      : { kind: 'template', id: 'jira-status-hook', label: 'Install jira-status hook' },
    detail:
      jiraHookInstalled && !jiraEnvConfigured()
        ? 'Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN'
        : undefined,
  });

  items.push({
    id: 'jira-env',
    label: 'Jira hook credentials (env)',
    category: 'optional',
    status: jiraEnvConfigured() ? 'ok' : 'unconfigured',
    detail: 'Required only for the jira-status hook',
  });

  const jiraIntegrations = listIntegrations().filter((i) => i.kind === 'jira' && i.enabled);
  items.push({
    id: 'jira-integration',
    label: 'Jira integration (API)',
    category: 'optional',
    status: jiraIntegrations.length > 0 ? 'ok' : 'unconfigured',
    configureUrl: '/integrations',
  });

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
  'editor',
  'gh',
  'skills',
  'jira-status-hook',
  'lazyvim-sync',
]);

export async function runSetupInstall(id: string): Promise<{ ok: boolean; message: string }> {
  if (!INSTALL_ALLOWLIST.has(id)) {
    throw new Error(`Install not allowed for: ${id}`);
  }

  if (id === 'skills') {
    const src = bundledSkillsDir();
    if (!fs.existsSync(src)) {
      return { ok: false, message: 'Bundled skills directory not found' };
    }
    const target = claudeSkillsDir();
    fs.mkdirSync(target, { recursive: true });
    let count = 0;
    for (const skill of fs.readdirSync(src)) {
      const skillSrc = path.join(src, skill);
      try {
        if (!fs.statSync(skillSrc).isDirectory()) continue;
      } catch {
        continue;
      }
      const dest = path.join(target, skill);
      if (!fs.existsSync(dest)) {
        fs.cpSync(skillSrc, dest, { recursive: true });
        count++;
      }
    }
    return {
      ok: true,
      message: count ? `Installed ${count} skill(s)` : 'All skills already present',
    };
  }

  if (id === 'jira-status-hook') {
    const files = installHookTemplate('jira-status');
    return { ok: true, message: `Installed hook (${files.length} file(s))` };
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

export function listSetupHookTemplates(): Array<{ id: string; installed: boolean }> {
  return listHookTemplates().map((id) => ({
    id,
    installed: isHookTemplateInstalled(id),
  }));
}
