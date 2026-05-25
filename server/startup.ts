import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import { brewInstall, probeBinary } from './binary-check.js';

const logger = childLogger('startup');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BinaryDep {
  cmd: string;
  checkArgs: string[];
  name?: string;
  brewPkg?: string;
  installUrl?: string;
}

// ─── Binary installer ────────────────────────────────────────────────────────

export function ensureBinary({ cmd, checkArgs, name, brewPkg, installUrl }: BinaryDep): void {
  const label = name || cmd;
  if (probeBinary({ cmd, checkArgs }).ok) return;

  if (brewPkg && process.platform === 'darwin' && brewInstall(brewPkg, { cmd, checkArgs })) {
    if (probeBinary({ cmd, checkArgs }).ok) return;
  }

  const url = installUrl || `https://formulae.brew.sh/formula/${brewPkg || cmd}`;
  logger.error({ label, install_url: url }, `${label} not found — install it manually`);
  process.exit(1);
}

/** Log a warning when a binary is missing; never exits. */
export function warnBinary({ cmd, checkArgs, name, installUrl, brewPkg }: BinaryDep): void {
  const label = name || cmd;
  if (probeBinary({ cmd, checkArgs }).ok) return;
  const url = installUrl || (brewPkg ? `https://formulae.brew.sh/formula/${brewPkg}` : undefined);
  logger.warn(
    { label, install_url: url },
    `${label} not found — install from the Setup page or run: octomux start after fixing`,
  );
}

// ─── Neovim version check ────────────────────────────────────────────────────

export function checkNeovimVersion(): void {
  let nvimVersion: { major: number; minor: number; raw: string } | undefined;
  try {
    const output = execFileSync('nvim', ['--version'], { encoding: 'utf8' });
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      nvimVersion = { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), raw: match[0] };
    }
  } catch {
    // shouldn't happen — ensureBinary already verified nvim exists
  }

  if (!nvimVersion) {
    logger.error('Could not determine neovim version');
    process.exit(1);
  }

  if (nvimVersion.major === 0 && nvimVersion.minor < 10) {
    logger.warn(
      { found: nvimVersion.raw, required: '>=0.10.0' },
      'Neovim version too old — upgrade with: brew upgrade neovim (or use VS Code/Cursor editor in Setup)',
    );
  }
}

// ─── LazyVim plugin sync ─────────────────────────────────────────────────────

export function syncLazyVimPlugins(repoRoot: string): void {
  const lazyDir = path.join(repoRoot, '.local', 'share', 'nvim', 'lazy');
  const needsSync = !existsSync(lazyDir) || readdirSync(lazyDir).length === 0;

  if (!needsSync) return;

  logger.info('Syncing LazyVim plugins (first run — this may take a minute)');
  try {
    execFileSync('nvim', ['--headless', '+Lazy! sync', '+qa'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(repoRoot, '.config'),
        XDG_DATA_HOME: path.join(repoRoot, '.local', 'share'),
        XDG_STATE_HOME: path.join(repoRoot, '.local', 'state'),
        XDG_CACHE_HOME: path.join(repoRoot, '.local', 'cache'),
      },
    });
  } catch (err) {
    logger.warn({ err }, 'LazyVim plugin sync failed — editor may not work correctly');
  }
}
