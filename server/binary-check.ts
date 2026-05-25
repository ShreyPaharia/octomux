import { execFileSync } from 'child_process';
import type { BinaryDep } from './startup.js';

export interface BinaryProbeResult {
  ok: boolean;
  version?: string;
}

/** Run a binary check without exiting the process. */
export function probeBinary({ cmd, checkArgs }: Pick<BinaryDep, 'cmd' | 'checkArgs'>): BinaryProbeResult {
  try {
    const out = execFileSync(cmd, checkArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const firstLine = out.split('\n')[0]?.trim();
    return { ok: true, version: firstLine || undefined };
  } catch {
    return { ok: false };
  }
}

export function hasBrew(): boolean {
  try {
    execFileSync('brew', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Install via Homebrew when available (darwin). Returns true on success. */
export function brewInstall(
  brewPkg: string,
  probe?: { cmd: string; checkArgs: string[] },
): boolean {
  if (process.platform !== 'darwin' || !hasBrew()) return false;
  const cmd = probe?.cmd ?? (brewPkg === 'neovim' ? 'nvim' : brewPkg);
  const checkArgs = probe?.checkArgs ?? (cmd === 'tmux' ? ['-V'] : ['--version']);
  try {
    execFileSync('brew', ['install', brewPkg], { stdio: 'inherit' });
    return probeBinary({ cmd, checkArgs }).ok;
  } catch {
    return false;
  }
}
