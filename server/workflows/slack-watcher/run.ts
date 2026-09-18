/**
 * Service layer for the slack-watcher vertical: loads the skill body,
 * interpolates schedule config plus the previous run's digested items (the
 * dedup memory), and runs headless via `runSessionVertical`. Slack tokens
 * reach the skill through the server's inherited environment — see
 * spec/slack-watcher.md §Slack app tokens.
 */
import { getSchedule } from '../../repositories/schedules.js';
import { listRunsForWorkflow, listRunsForSchedule } from '../../repositories/runs.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { interpolatePrompt } from '../../prompt-interpolate.js';
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
  /** Comma-separated absolute repo paths the watcher may create draft tasks in. */
  workRepos?: string;
  /** Channel announcing work the watcher triggered. Empty (or no workRepos) = feature off. */
  workChannel?: string;
  trigger?: 'cron' | 'manual';
  model?: string | null;
  timeoutMs?: number | null;
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
  taskId?: string;
}

export interface SlackWatcherResult {
  outcome: 'done' | 'blocked' | 'failed';
  window: string;
  summary: string;
  digestSent: boolean;
  items: SlackWatcherItem[];
}

/**
 * Items from the most recent finished run for the given schedule — injected
 * as the skill's dedup memory. When scheduleId is provided, filters by
 * `runs.schedule_id` so that two watcher schedules do not cross-contaminate
 * each other's dedup memory. When null/undefined, falls back to the global
 * kind-level list (legacy behaviour for callers without a scheduleId).
 */
export function previousItemsJson(scheduleId?: string | null): string {
  const runs =
    scheduleId != null ? listRunsForSchedule(scheduleId) : listRunsForWorkflow('slack-watcher');
  const last = runs.find((r) => r.status === 'done' && r.result_json);
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
  // Self-contained schedule row (spec/schedule-kinds-as-presets.md §1):
  // schedule.prompt is materialized from the kind's preset at create time —
  // no resolution chain, just a read.
  const skillContent = (input.scheduleId ? getSchedule(input.scheduleId) : undefined)?.prompt;
  if (!skillContent) {
    throw new Error(`slack-watcher: schedule ${input.scheduleId ?? '(none)'} has no prompt`);
  }
  const prompt = interpolatePrompt(skillContent, {
    slackUserId: input.slackUserId,
    digestTarget: input.digestTarget,
    telegramChatId: input.telegramChatId,
    digestUserId: input.digestUserId,
    lookbackMinutes: input.lookbackMinutes,
    digestChannel: input.digestChannel,
    workRepos: input.workRepos ?? '',
    workChannel: input.workChannel ?? '',
    // previousItems is pre-stringified JSON — passed as a string scalar so it
    // lands verbatim (interpolatePrompt calls String() on scalars).
    previousItems: previousItemsJson(input.scheduleId),
  });

  return runSessionVertical<SlackWatcherResult>({
    kind: 'slack-watcher',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: SLACK_WATCHER_SCHEMA,
    trigger: input.trigger ?? 'cron',
    model: input.model,
    timeoutMs: input.timeoutMs,
  });
}
