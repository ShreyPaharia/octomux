/**
 * Service layer for the overnight-log-summary vertical: loads the skill body,
 * interpolates the schedule's log command, and runs it as a headless
 * `runSessionVertical` call (session run — no task/worktree/loop).
 */
import { getSkill } from '../../skills.js';
import { repoShortName } from '../../review-tasks.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { OVERNIGHT_LOG_SUMMARY_SCHEMA } from './schema.js';

export interface RunOvernightLogSummaryInput {
  repoPath: string;
  scheduleId?: string | null;
  logCommand: string;
}

export interface OvernightLogSummaryResult {
  window: string;
  summary: string;
  errorClasses: Array<{ name: string; count: number; severity: 'low' | 'medium' | 'high' }>;
  notableEvents: string[];
}

export async function runOvernightLogSummary(
  input: RunOvernightLogSummaryInput,
): Promise<{ result: OvernightLogSummaryResult }> {
  const skill = await getSkill('overnight-log-summary', { repoPath: input.repoPath });
  const prompt = skill.content
    .replace(/\{\{logCommand\}\}/g, input.logCommand)
    .replace(/\{\{repoShort\}\}/g, repoShortName(input.repoPath));

  return runSessionVertical<OvernightLogSummaryResult>({
    kind: 'overnight-log-summary',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: OVERNIGHT_LOG_SUMMARY_SCHEMA,
  });
}
