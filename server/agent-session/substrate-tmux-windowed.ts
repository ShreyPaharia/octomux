import { execTmux } from '../tmux-bin.js';
import { childLogger } from '../logger.js';

const logger = childLogger('agent-session/substrate-tmux-windowed');

/** Get the active window index of a tmux session. */
export async function getActiveWindowIndex(session: string): Promise<number> {
  const { stdout } = await execTmux(['display-message', '-t', session, '-p', '#{window_index}']);
  return parseInt(stdout.trim(), 10);
}

/** Get the index of the last window in a tmux session. */
export async function getLastWindowIndex(session: string): Promise<number> {
  const { stdout } = await execTmux(['list-windows', '-t', session, '-F', '#{window_index}']);
  const indices = stdout.trim().split('\n').map(Number);
  return Math.max(...indices);
}

export interface TmuxWindowLaunchOptions {
  session: string;
  cwd: string;
  startupCmd?: string;
  fresh: boolean;
}

/**
 * Detached, multi-window tmux orchestration for the live dashboard task path.
 *
 * Creates or reuses a named session, adds windows without a parent-held pty, and
 * returns a window index for external attach (xterm.js grouped viewer sessions).
 * Distinct from `tmuxSubstrate` (spawn-and-hold-a-pty for headless `runAgentSession`).
 */
export interface TmuxWindowSubstrate {
  readonly kind: 'tmux-windowed';
  launchWindow(opts: TmuxWindowLaunchOptions): Promise<number>;
  createEmptySession(opts: { session: string; cwd: string }): Promise<void>;
}

function appendStartupCmd(args: string[], startupCmd?: string): string[] {
  if (startupCmd) args.push(startupCmd);
  return args;
}

export const tmuxWindowSubstrate: TmuxWindowSubstrate = {
  kind: 'tmux-windowed',

  async launchWindow(opts: TmuxWindowLaunchOptions): Promise<number> {
    const { session, cwd, startupCmd, fresh } = opts;

    logger.debug(
      { session, cwd, fresh, has_startup_cmd: Boolean(startupCmd) },
      'launching tmux window',
    );

    if (fresh) {
      await execTmux(appendStartupCmd(['new-session', '-d', '-s', session, '-c', cwd], startupCmd));
      await execTmux(['set-option', '-t', session, 'aggressive-resize', 'on']);
      return getActiveWindowIndex(session);
    }

    await execTmux(appendStartupCmd(['new-window', '-t', session, '-c', cwd], startupCmd));
    return getLastWindowIndex(session);
  },

  async createEmptySession(opts: { session: string; cwd: string }): Promise<void> {
    const { session, cwd } = opts;
    logger.debug({ session, cwd }, 'creating empty tmux session');
    await execTmux(['new-session', '-d', '-s', session, '-c', cwd]);
    await execTmux(['set-option', '-t', session, 'aggressive-resize', 'on']);
  },
};
