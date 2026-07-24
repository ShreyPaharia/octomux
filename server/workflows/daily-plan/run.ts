/**
 * Service layer for the daily-plan vertical: loads the skill body and starts
 * an interactive chat (not a headless session) — the agent preps the day's
 * plan, then waits for the user to join and steer.
 */
import { resolveSchedulePrompt } from '../../schedule-prompt.js';
import { createChat } from '../../chats.js';
import { insertRun, listRunsForWorkflow, finishRun } from '../../repositories/runs.js';
import { childLogger } from '../../logger.js';
import type { RunResult } from '../../types.js';

const logger = childLogger('workflows/daily-plan');

export interface RunDailyPlanFromScheduleInput {
  scheduleId: string;
  trigger?: 'cron' | 'manual';
  model?: string | null;
}

export async function runDailyPlanFromSchedule(
  input: RunDailyPlanFromScheduleInput,
): Promise<void> {
  const prompt = await resolveSchedulePrompt({
    scheduleId: input.scheduleId,
    kind: 'daily-plan',
  });
  const agent = await createChat({ prompt, model: input.model });
  const trigger = input.trigger ?? 'cron';

  insertRun({
    workflowKind: 'daily-plan',
    trigger,
    scheduleId: input.scheduleId,
    chatId: agent.id,
  });
}

/**
 * daily-plan is chat-backed with no `task_id`, so the effective-status
 * `COALESCE` rescue over `tasks.runtime_state` (runs.ts) can't help it — its
 * run row needs an explicit finish. Called from the chat-close route
 * (`PATCH /api/chats/:id`); a no-op for any chat that isn't a daily-plan run.
 */
export function finishDailyPlanRunForChat(chatId: string): void {
  const run = listRunsForWorkflow('daily-plan').find(
    (r) => r.chat_id === chatId && r.status === 'running',
  );
  if (!run) return;

  finishRun(run.id, {
    status: 'done',
    result: {
      outcome: 'done',
      summary: 'Daily planning session completed.',
      links: [{ label: 'Chat', url: `/chats/${chatId}` }],
    } satisfies RunResult,
  });
  logger.info({ chat_id: chatId, run_id: run.id }, 'daily-plan: run finished on chat close');
}
