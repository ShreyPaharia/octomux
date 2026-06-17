import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const PASTE_TO_ENTER_DELAY_MS = 50;

/**
 * Prepare a prompt for delivery via bracketed-paste send-keys.
 *
 * A normal multi-line prose prompt is pasted verbatim — Claude Code keeps the
 * newlines. But a prompt that begins with `/` is parsed by the TUI as a
 * single-line slash command, which strips embedded newlines and glues the
 * surrounding tokens together (e.g. `/review-orchestrator` + `Review…` ->
 * `/review-orchestratorReview…`, an unknown command). For those we collapse
 * the whole prompt to one line so the command name stays intact with its args
 * inline. Used by the launch-time re-delivery safety net in `task-runner`.
 */
export function normalizePromptForPaste(prompt: string): string {
  if (!prompt.trimStart().startsWith('/')) return prompt;
  return prompt.replace(/\s+/g, ' ').trim();
}

/**
 * Send a user message to a running Claude Code TUI inside a tmux window.
 *
 * Two-call protocol: tmux delivers the multi-character `message` as a
 * bracketed-paste payload to the TUI. If we also pass `Enter` in the same
 * send-keys invocation, the TUI absorbs the Enter into the paste payload as
 * a literal newline rather than treating it as a submit. The workaround is
 * to send the text first (using `-l` to force literal interpretation), pause
 * briefly so the TUI finishes processing the paste, then send Enter as a
 * separate keysym.
 *
 * Do NOT use this for sending shell commands to a tmux pane that holds a
 * shell prompt (no bracketed-paste handling there) — the single-call pattern
 * is fine, faster, and `server/chats.ts` relies on it.
 */
export async function sendMessageToAgent(
  session: string,
  windowIndex: number,
  message: string,
): Promise<void> {
  const target = `${session}:${windowIndex}`;
  await execFile('tmux', ['send-keys', '-t', target, '-l', message]);
  await new Promise<void>((resolve) => setTimeout(resolve, PASTE_TO_ENTER_DELAY_MS));
  await execFile('tmux', ['send-keys', '-t', target, 'Enter']);
}
