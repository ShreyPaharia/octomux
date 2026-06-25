import { execTmux } from '../tmux-bin.js';

export {
  getActiveWindowIndex,
  getLastWindowIndex,
} from '../agent-session/substrate-tmux-windowed.js';

/**
 * True when an execFile error stems from tmux reporting that a target
 * session/window/pane does not exist — which happens routinely during cleanup
 * (session already killed, window already closed) and is not worth a warn.
 */
export function isTmuxTargetMissing(err: unknown): boolean {
  const stderr = (err as { stderr?: string } | null)?.stderr ?? '';
  return /can't find (?:session|window|pane):/i.test(stderr);
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
