/**
 * Service layer for the slack-watcher vertical: loads the skill body,
 * interpolates schedule config plus the previous run's digested items (the
 * dedup memory), and runs headless via `runSessionVertical`. Slack tokens
 * reach the skill through the server's inherited environment — see
 * spec/slack-watcher.md §Slack app tokens.
 */
import { resolveSchedulePrompt } from '../../schedule-prompt.js';
import { listRunsForWorkflow } from '../../repositories/runs.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { SLACK_WATCHER_SCHEMA } from './schema.js';

export interface RunSlackWatcherInput {
  repoPath: string;
  scheduleId?: string | null;
  /** Owner's member id in the watched workspace — whose inbox to search. */
  slackUserId: string;
  /** Digest destination: 'slack' (DM/channel via the bot) or 'telegram'. */
  digestTarget: string;
  /** Telegram numeric chat id — used when digestTarget is 'telegram'. */
  telegramChatId: string;
  /** Owner's member id in the bot's workspace — whom the bot DMs. */
  digestUserId: string;
  lookbackMinutes: number;
  digestChannel: string;
  trigger?: 'cron' | 'manual';
}

export interface SlackWatcherItem {
  channel: string;
  from: string;
  about: string;
  urgency: 'low' | 'medium' | 'high';
  suggestedReply?: string;
  permalink?: string;
  replyChannel?: string;
  replyTs?: string;
}

export interface SlackWatcherResult {
  outcome: 'done' | 'blocked' | 'failed';
  window: string;
  summary: string;
  digestSent: boolean;
  items: SlackWatcherItem[];
}

/** Items from the most recent finished run — injected as the skill's dedup memory. */
export function previousItemsJson(): string {
  const last = listRunsForWorkflow('slack-watcher').find(
    (r) => r.status === 'done' && r.result_json,
  );
  if (!last) return '[]';
  try {
    const result = JSON.parse(last.result_json!) as { items?: unknown };
    return JSON.stringify(Array.isArray(result.items) ? result.items : []);
  } catch {
    return '[]';
  }
}

export async function runSlackWatcher(
  input: RunSlackWatcherInput,
): Promise<{ result: SlackWatcherResult }> {
  const skillContent = await resolveSchedulePrompt({
    scheduleId: input.scheduleId,
    kind: 'slack-watcher',
  });
  const prompt = skillContent
    .replace(/\{\{slackUserId\}\}/g, input.slackUserId)
    .replace(/\{\{digestTarget\}\}/g, input.digestTarget)
    .replace(/\{\{telegramChatId\}\}/g, input.telegramChatId)
    .replace(/\{\{digestUserId\}\}/g, input.digestUserId)
    .replace(/\{\{lookbackMinutes\}\}/g, String(input.lookbackMinutes))
    .replace(/\{\{digestChannel\}\}/g, input.digestChannel)
    .replace(/\{\{previousItems\}\}/g, previousItemsJson());

  return runSessionVertical<SlackWatcherResult>({
    kind: 'slack-watcher',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: SLACK_WATCHER_SCHEMA,
    trigger: input.trigger ?? 'cron',
  });
}
