/**
 * Service layer for the weekly-update vertical: loads the skill body and
 * runs it as a headless `runSessionVertical` call (session run — no
 * task/worktree/loop).
 */
import { getSkill } from '../../skills.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';

export interface RunWeeklyUpdateInput {
  repoPath: string;
  scheduleId?: string | null;
}

export interface WeeklyUpdateResult {
  period: string;
  themes: Array<{ title: string; items: string[] }>;
  highlights: string[];
}

export async function runWeeklyUpdate(
  input: RunWeeklyUpdateInput,
): Promise<{ result: WeeklyUpdateResult }> {
  const skill = await getSkill('weekly-update', { repoPath: input.repoPath });

  return runSessionVertical<WeeklyUpdateResult>({
    kind: 'weekly-update',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: skill.content,
    outputSchema: WEEKLY_UPDATE_SCHEMA,
  });
}
