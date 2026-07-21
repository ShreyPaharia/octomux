/**
 * Resolve workflow prompts for cron schedules: DB override when set, else the
 * shipped SKILL.md default. Task-backed kinds also get file overrides via
 * `syncSkills` so the agent reads the DB prompt from its worktree.
 */
import { getSkill } from './skills.js';
import { getSchedule } from './repositories/schedules.js';

export const CRON_PROMPT_KINDS = [
  'doc-drift',
  'prod-log-triage',
  'weekly-update',
  'overnight-log-summary',
  'daily-plan',
] as const;

export type CronPromptKind = (typeof CRON_PROMPT_KINDS)[number];

const TASK_BACKED_KINDS = new Set<string>(['doc-drift', 'prod-log-triage']);

export function isCronPromptKind(kind: string): kind is CronPromptKind {
  return (CRON_PROMPT_KINDS as readonly string[]).includes(kind);
}

/** Load the shipped SKILL.md body for a cron workflow kind. */
export async function getDefaultPromptForKind(kind: string, repoPath?: string): Promise<string> {
  if (!isCronPromptKind(kind)) {
    throw new Error(`No default prompt for workflow kind: ${kind}`);
  }
  const skill = await getSkill(kind, repoPath ? { repoPath } : undefined);
  return skill.content;
}

/** DB prompt when present, otherwise the SKILL.md default for this kind/repo. */
export async function resolveSchedulePrompt(input: {
  scheduleId?: string | null;
  kind: string;
  repoPath?: string;
}): Promise<string> {
  if (input.scheduleId) {
    const schedule = getSchedule(input.scheduleId);
    if (schedule?.prompt) return schedule.prompt;
    if (schedule) {
      return getDefaultPromptForKind(schedule.kind, schedule.repo_path);
    }
  }
  return getDefaultPromptForKind(input.kind, input.repoPath);
}

/** Overrides to pass into `syncSkills` for task-backed scheduled runs. */
export function skillContentOverridesForSchedule(schedule: {
  kind: string;
  prompt: string | null;
}): Record<string, string> | undefined {
  if (!schedule.prompt || !TASK_BACKED_KINDS.has(schedule.kind)) return undefined;
  return { [schedule.kind]: schedule.prompt };
}

export function skillContentOverridesForScheduleId(
  scheduleId: string | null | undefined,
): Record<string, string> | undefined {
  if (!scheduleId) return undefined;
  const schedule = getSchedule(scheduleId);
  if (!schedule) return undefined;
  return skillContentOverridesForSchedule(schedule);
}
