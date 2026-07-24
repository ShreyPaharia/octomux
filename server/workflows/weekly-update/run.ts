/**
 * Service layer for the weekly-update vertical: loads the skill body and
 * runs it as a headless `runSessionVertical` call (session run — no
 * task/worktree/loop).
 */
import { resolveSchedulePrompt } from '../../schedule-prompt.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';

export interface RunWeeklyUpdateInput {
  repoPath: string;
  scheduleId?: string | null;
  trigger?: 'cron' | 'manual';
  model?: string | null;
  timeoutMs?: number | null;
}

export interface WeeklyUpdateResult {
  period: string;
  themes: Array<{ title: string; items: string[] }>;
  highlights: string[];
}

export async function runWeeklyUpdate(
  input: RunWeeklyUpdateInput,
): Promise<{ result: WeeklyUpdateResult }> {
  const prompt = await resolveSchedulePrompt({
    scheduleId: input.scheduleId,
    kind: 'weekly-update',
    repoPath: input.repoPath,
  });

  return runSessionVertical<WeeklyUpdateResult>({
    kind: 'weekly-update',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: WEEKLY_UPDATE_SCHEMA,
    trigger: input.trigger ?? 'cron',
    model: input.model,
    timeoutMs: input.timeoutMs,
  });
}
