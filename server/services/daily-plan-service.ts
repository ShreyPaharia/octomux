/**
 * Service layer for the daily-plan vertical: loads the skill body and starts
 * an interactive chat (not a headless session) — the agent preps the day's
 * plan, then waits for the user to join and steer.
 */
import { getSkill } from '../skills.js';
import { createChat } from '../chats.js';
import { insertRun } from '../repositories/runs.js';

export interface RunDailyPlanFromScheduleInput {
  scheduleId: string;
}

export async function runDailyPlanFromSchedule(
  input: RunDailyPlanFromScheduleInput,
): Promise<void> {
  const skill = await getSkill('daily-plan');
  const agent = await createChat({ prompt: skill.content });

  insertRun({
    workflowKind: 'daily-plan',
    trigger: 'cron',
    scheduleId: input.scheduleId,
    chatId: agent.id,
  });
}
