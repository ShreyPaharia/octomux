/**
 * One-shot headless vertical that sends a single click-approved slack-watcher
 * reply, verbatim, into the watched-workspace thread. Runs through the same
 * `runSessionVertical` + claude.ai Slack connector path the watcher reads
 * with — the conductor cannot do this (strict MCP config), a session vertical
 * can (spec/slack-watcher.md §v2).
 */
import { registerWorkflow } from '../registry.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';

export interface SendWatcherReplyInput {
  workspaceDir: string;
  /** Watched-workspace channel id the reply goes to. */
  channel: string;
  /** Thread ts the reply attaches to. */
  threadTs: string;
  /** The exact reply text — sent verbatim, never composed. */
  text: string;
}

export interface SendReplyResult {
  outcome: 'done' | 'failed';
  error?: string;
}

export const SEND_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'failed'] },
    error: { type: 'string' },
  },
  required: ['outcome'],
  additionalProperties: false,
};

/** Feed-only kind: runs rows render on /runs, but it is never cron-schedulable. */
registerWorkflow({
  kind: 'slack-watcher-reply',
  displayName: 'Slack Watcher Reply',
  surfaces: ['feed'],
  output: SEND_REPLY_SCHEMA,
  trigger: { kind: 'manual' },
});

function buildPrompt(input: SendWatcherReplyInput): string {
  return [
    'You are sending one owner-approved Slack reply. This is a headless, unattended',
    'session: your only side effects are one Slack send and one `submit_result` call.',
    '',
    'Using your Slack MCP connector send tool (`slack_send_message`), post EXACTLY this',
    'text — no edits, no additions, no follow-up messages:',
    '',
    `channel_id: ${input.channel}`,
    `thread_ts: ${input.threadTs}`,
    `text: ${input.text}`,
    '',
    'Then call `submit_result` exactly once with `{"outcome":"done"}` — or',
    '`{"outcome":"failed","error":"<why>"}` if the send tool is unavailable or the send',
    'errors. Do not compose, retry endlessly, or send anything else.',
  ].join('\n');
}

export async function sendWatcherReply(
  input: SendWatcherReplyInput,
): Promise<SendReplyResult> {
  try {
    const { result } = await runSessionVertical<SendReplyResult>({
      kind: 'slack-watcher-reply',
      workspaceDir: input.workspaceDir,
      input: buildPrompt(input),
      outputSchema: SEND_REPLY_SCHEMA,
      trigger: 'manual',
    });
    return result;
  } catch (err) {
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
