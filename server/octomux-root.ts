import path from 'path';
import os from 'os';

/**
 * Base octomux state directory (the "~/.octomux" equivalent).
 * OCTOMUX_DATA_DIR overrides it — the Electron app sets this to an app-private
 * path so it never shares the CLI's ~/.octomux (DB + tmux socket + logs, etc.).
 */
export function octomuxRoot(): string {
  return process.env.OCTOMUX_DATA_DIR ?? path.join(os.homedir(), '.octomux');
}
