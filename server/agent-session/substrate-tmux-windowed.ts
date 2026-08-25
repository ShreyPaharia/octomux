import { childLogger } from '../logger.js';
import type { ComputeSession } from '../compute/types.js';

const logger = childLogger('agent-session/substrate-tmux-windowed');

/** Get the active window index of a tmux session. */
export async function getActiveWindowIndex(c: ComputeSession, session: string): Promise<number> {
  const { stdout } = await c.tmux(['display-message', '-t', session, '-p', '#{window_index}']);
  return parseInt(stdout.trim(), 10);
}

/** Get the index of the last window in a tmux session. */
export async function getLastWindowIndex(c: ComputeSession, session: string): Promise<number> {
  const { stdout } = await c.tmux(['list-windows', '-t', session, '-F', '#{window_index}']);
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
  launchWindow(c: ComputeSession, opts: TmuxWindowLaunchOptions): Promise<number>;
  createEmptySession(c: ComputeSession, opts: { session: string; cwd: string }): Promise<void>;
}

function appendStartupCmd(args: string[], startupCmd?: string): string[] {
  if (startupCmd) args.push(startupCmd);
  return args;
}

export const tmuxWindowSubstrate: TmuxWindowSubstrate = {
  kind: 'tmux-windowed',

  async launchWindow(c: ComputeSession, opts: TmuxWindowLaunchOptions): Promise<number> {
    const { session, cwd, startupCmd, fresh } = opts;

    logger.debug(
      { session, cwd, fresh, has_startup_cmd: Boolean(startupCmd) },
      'launching tmux window',
    );

    // Fresh sessions chain all three tmux commands into one invocation (`;` is
    // tmux's command separator) — one process spawn instead of three. Each
    // spawn is ~140ms, which was ~25% of task-creation wall clock.
    if (fresh) {
      const { stdout } = await c.tmux([
        ...appendStartupCmd(['new-session', '-d', '-s', session, '-c', cwd], startupCmd),
        ';',
        'set-option',
        '-t',
        session,
        'aggressive-resize',
        'on',
        ';',
        'display-message',
        '-t',
        session,
        '-p',
        '#{window_index}',
      ]);
      return parseInt(stdout.trim(), 10);
    }

    await c.tmux(appendStartupCmd(['new-window', '-t', session, '-c', cwd], startupCmd));
    return getLastWindowIndex(c, session);
  },

  async createEmptySession(
    c: ComputeSession,
    opts: { session: string; cwd: string },
  ): Promise<void> {
    const { session, cwd } = opts;
    logger.debug({ session, cwd }, 'creating empty tmux session');
    await c.tmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      cwd,
      ';',
      'set-option',
      '-t',
      session,
      'aggressive-resize',
      'on',
    ]);
  },
};
