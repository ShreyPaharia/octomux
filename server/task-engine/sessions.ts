import { execTmux } from '../tmux-bin.js';

/**
 * True when an execFile error stems from tmux reporting that a target
 * session/window/pane does not exist — which happens routinely during cleanup
 * (session already killed, window already closed) and is not worth a warn.
 */
export function isTmuxTargetMissing(err: unknown): boolean {
  const stderr = (err as { stderr?: string } | null)?.stderr ?? '';
  return /can't find (?:session|window|pane):/i.test(stderr);
}

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

/**
 * Kill all linked viewer sessions (`<tmuxSession>-v-*`) for a specific task.
 */
export async function cleanupLinkedSessions(tmuxSession: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execTmux(['list-sessions', '-F', '#{session_name}']));
  } catch {
    return;
  }

  const prefix = `${tmuxSession}-v-`;
  const linked = stdout
    .trim()
    .split('\n')
    .filter((name) => name.startsWith(prefix));

  for (const session of linked) {
    await execTmux(['kill-session', '-t', session]).catch(() => {});
  }
}

/**
 * Clean up orphaned `-v-` viewer sessions from previous runs.
 */
export async function cleanupOrphanedViewerSessions(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execTmux(['list-sessions', '-F', '#{session_name}']));
  } catch {
    return;
  }

  const sessions = new Set(stdout.trim().split('\n').filter(Boolean));
  const viewerPattern = /^(octomux-agent-.+)-v-/;

  for (const name of sessions) {
    const match = name.match(viewerPattern);
    if (match) {
      const parentSession = match[1];
      if (!sessions.has(parentSession)) {
        await execTmux(['kill-session', '-t', name]).catch(() => {});
      }
    }
  }
}
