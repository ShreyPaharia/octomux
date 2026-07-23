/**
 * Resolve workflow prompts for cron schedules. The DB `schedule_skills` table
 * is the single source of truth: one editable body per cron kind, lazily
 * seeded once from the shipped SKILL.md the first time a kind is read. There is
 * no per-schedule override and no SKILL.md runtime fallback. Task-backed kinds
 * pass the DB body into harness plugin flags via an ephemeral overlay plugin
 * at launch (`appendOctomuxPluginFlags`).
 */
import { getSkill } from './skills.js';
import { getSchedule } from './repositories/schedules.js';
import { getScheduleSkillRow, upsertScheduleSkill } from './repositories/schedule-skills.js';

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

/** The shipped SKILL.md body for a cron kind — the seed / "reset to default" source. */
export async function getDefaultPromptForKind(kind: string): Promise<string> {
  if (!isCronPromptKind(kind)) {
    throw new Error(`No default prompt for workflow kind: ${kind}`);
  }
  const skill = await getSkill(kind);
  return skill.content;
}

/**
 * The DB body for a cron kind. Lazily self-seeds from the shipped SKILL.md the
 * first time it's read, making the DB authoritative thereafter.
 */
export async function resolveScheduleSkillContent(kind: string): Promise<string> {
  const row = getScheduleSkillRow(kind);
  if (row) return row.content;
  const seed = await getDefaultPromptForKind(kind);
  upsertScheduleSkill(kind, seed);
  return seed;
}

/** The workflow prompt for a scheduled run — always the DB body for the kind. */
export async function resolveSchedulePrompt(input: {
  scheduleId?: string | null;
  kind: string;
  repoPath?: string;
}): Promise<string> {
  return resolveScheduleSkillContent(input.kind);
}

/**
 * Overrides passed into harness plugin flags for task-backed scheduled runs so
 * the agent reads the DB skill body via an ephemeral overlay plugin. Always
 * injects the DB body for doc-drift / prod-log-triage; undefined for every
 * other kind.
 */
export async function skillContentOverridesForScheduleId(
  scheduleId: string | null | undefined,
): Promise<Record<string, string> | undefined> {
  if (!scheduleId) return undefined;
  const schedule = getSchedule(scheduleId);
  if (!schedule || !TASK_BACKED_KINDS.has(schedule.kind)) return undefined;
  return { [schedule.kind]: await resolveScheduleSkillContent(schedule.kind) };
}
