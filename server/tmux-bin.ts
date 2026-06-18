/**
 * Central tmux resolver — single source of truth for invoking tmux.
 *
 * Binary resolution order (memoized):
 *   1. OCTOMUX_TMUX_BIN env var
 *   2. Bundled @octomux/tmux-<platform>-<arch> package (optional dep, may not exist)
 *   3. PATH 'tmux' fallback
 *
 * All callers should use execTmux() (async) or tmuxBinPath() + tmuxBaseArgs()
 * (sync/pty). The -S socket prefix is applied to every invocation.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { probeBinary } from './binary-check.js';
import { childLogger } from './logger.js';

const logger = childLogger('tmux-bin');
const execFileProm = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Data directory (same logic as db.ts) ─────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production';
const PROD_DATA_DIR = path.join(os.homedir(), '.octomux');
const DEV_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = isProduction ? PROD_DATA_DIR : DEV_DATA_DIR;

// ─── Resolution result ─────────────────────────────────────────────────────────

export interface TmuxResolution {
  /** Absolute (or PATH-relative) path to the tmux binary. */
  path: string;
  /** How the binary was located. */
  source: 'env' | 'bundled' | 'path';
  /** Whether probeBinary confirmed it works. */
  verified: boolean;
  /** The bundled terminfo directory, if the bundled package is in use. */
  terminfoDir?: string;
}

// ─── Memoized resolution ───────────────────────────────────────────────────────

let _resolution: TmuxResolution | null = null;

function resolve(): TmuxResolution {
  if (_resolution) return _resolution;

  // 1. Env override
  if (process.env.OCTOMUX_TMUX_BIN) {
    const p = process.env.OCTOMUX_TMUX_BIN;
    const verified = probeBinary({ cmd: p, checkArgs: ['-V'] }).ok;
    _resolution = { path: p, source: 'env', verified };
    logger.debug({ path: p, source: 'env', verified }, 'tmux resolved via env override');
    return _resolution;
  }

  // 2. Bundled package
  try {
    const platform = process.platform; // 'darwin' | 'linux' | …
    const arch = process.arch; // 'arm64' | 'x64' | …
    const pkgName = `@octomux/tmux-${platform}-${arch}`;
    const req = createRequire(import.meta.url);
    // The package exports { tmuxBin, terminfoDir } as its main index.js
    const bundled = req(pkgName) as { tmuxBin: string; terminfoDir?: string };
    if (bundled.tmuxBin) {
      const verified = probeBinary({ cmd: bundled.tmuxBin, checkArgs: ['-V'] }).ok;
      _resolution = {
        path: bundled.tmuxBin,
        source: 'bundled',
        verified,
        terminfoDir: bundled.terminfoDir,
      };
      logger.debug(
        { path: bundled.tmuxBin, source: 'bundled', verified, terminfoDir: bundled.terminfoDir },
        'tmux resolved via bundled package',
      );
      return _resolution;
    }
  } catch {
    // Package not installed yet — expected until binaries are published.
  }

  // 3. PATH fallback
  const verified = probeBinary({ cmd: 'tmux', checkArgs: ['-V'] }).ok;
  _resolution = { path: 'tmux', source: 'path', verified };
  logger.debug({ source: 'path', verified }, 'tmux resolved via PATH fallback');
  return _resolution;
}

/** Reset the memoized resolution (for testing). */
export function _resetTmuxResolution(): void {
  _resolution = null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** The current resolution result — includes source and verified flag. */
export function tmuxResolution(): TmuxResolution {
  return resolve();
}

/** Absolute (or PATH-relative) path to the tmux binary octomux should use. */
export function tmuxBinPath(): string {
  return resolve().path;
}

/**
 * Base args every tmux invocation must include (the private socket).
 * Pure — no fs side effects; call ensureTmuxRuntimeDir() at boot.
 */
export function tmuxBaseArgs(): string[] {
  const sockPath = path.join(DATA_DIR, 'run', 'tmux.sock');
  return ['-S', sockPath];
}

/**
 * Env additions for every tmux spawn (adds TERMINFO_DIRS when the bundled
 * package exposes a terminfo directory).
 */
export function tmuxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { terminfoDir } = resolve();
  if (!terminfoDir) return { ...base };
  // Trailing colon preserves the system terminfo search path.
  return { ...base, TERMINFO_DIRS: `${terminfoDir}:${base.TERMINFO_DIRS ?? ''}` };
}

/**
 * Convenience: run tmux via promisified execFile with socket + env applied.
 * args should be the tmux subcommand args (e.g. ['new-session', '-d', '-s', name]).
 * The -S <sock> prefix is prepended automatically.
 */
export async function execTmux(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const bin = tmuxBinPath();
  const fullArgs = [...tmuxBaseArgs(), ...args];
  const env = tmuxEnv();
  return execFileProm(bin, fullArgs, { ...opts, env }) as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Convenience for node-pty: returns { file, args, env } to spawn an attach.
 * extraArgs should be the tmux subcommand + its args (e.g. ['attach-session', '-t', target]).
 */
export function tmuxSpawnSpec(extraArgs: string[]): {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  return {
    file: tmuxBinPath(),
    args: [...tmuxBaseArgs(), ...extraArgs],
    env: tmuxEnv(),
  };
}

/**
 * Create the run/ directory that holds the tmux socket.
 * Call this at server boot, NOT during path computation.
 */
let _runtimeDirEnsured = false;
export function ensureTmuxRuntimeDir(): void {
  if (_runtimeDirEnsured) return;
  const runDir = path.join(DATA_DIR, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  _runtimeDirEnsured = true;
}
