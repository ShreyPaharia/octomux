/**
 * Resolve workflow prompts for cron schedules. The DB `schedule_skills` table
 * is the single source of truth: one editable body per cron kind, lazily
 * seeded once from the shipped SKILL.md the first time a kind is read.
 *
 * Resolution precedence (§4.1):
 *   1. `schedules.prompt` for the given `scheduleId` — if non-empty, use it.
 *   2. `schedule_skills[kind]` — lazily seeded from shipped SKILL.md (unchanged).
 *
 * Task-backed kinds pass the resolved body into harness plugin flags via an
 * ephemeral overlay plugin at launch (`appendOctomuxPluginFlags`).
 */
import { getSkill } from './skills.js';
import { getSchedule } from './repositories/schedules.js';
import { getScheduleSkillRow, upsertScheduleSkill } from './repositories/schedule-skills.js';
import { childLogger } from './logger.js';

const logger = childLogger('schedule-prompt');

export const CRON_PROMPT_KINDS = [
  'doc-drift',
  'prod-log-triage',
  'weekly-update',
  'overnight-log-summary',
  'daily-plan',
  'slack-watcher',
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

/**
 * Resolve the workflow prompt for a scheduled run, returning both the content
 * and its source so callers can log or expose the resolution path.
 *
 * Precedence:
 *   1. schedules.prompt (non-empty) → source: 'override'
 *   2. schedule_skills[kind] (lazy-seeded from SKILL.md) → source: 'kind_skill'
 */
export async function resolveSchedulePromptWithSource(input: {
  scheduleId?: string | null;
  kind: string;
}): Promise<{ content: string; source: 'override' | 'kind_skill' }> {
  if (input.scheduleId) {
    const schedule = getSchedule(input.scheduleId);
    if (schedule && schedule.prompt) {
      logger.debug(
        { schedule_id: input.scheduleId, kind: input.kind, prompt_source: 'override' },
        'resolved schedule prompt',
      );
      return { content: schedule.prompt, source: 'override' };
    }
  }

  const content = await resolveScheduleSkillContent(input.kind);
  logger.debug(
    { schedule_id: input.scheduleId ?? null, kind: input.kind, prompt_source: 'kind_skill' },
    'resolved schedule prompt',
  );
  return { content, source: 'kind_skill' };
}

/** The workflow prompt for a scheduled run — respects per-schedule override. */
export async function resolveSchedulePrompt(input: {
  scheduleId?: string | null;
  kind: string;
  repoPath?: string;
}): Promise<string> {
  const { content } = await resolveSchedulePromptWithSource(input);
  return content;
}

/**
 * Overrides passed into harness plugin flags for task-backed scheduled runs so
 * the agent reads the DB skill body via an ephemeral overlay plugin. Always
 * injects the DB body for doc-drift / prod-log-triage; undefined for every
 * other kind.
 *
 * When `schedule.prompt` is non-empty the override wins; otherwise falls back
 * to the kind skill body as today.
 */
export async function skillContentOverridesForScheduleId(
  scheduleId: string | null | undefined,
): Promise<Record<string, string> | undefined> {
  if (!scheduleId) return undefined;
  const schedule = getSchedule(scheduleId);
  if (!schedule || !TASK_BACKED_KINDS.has(schedule.kind)) return undefined;

  if (schedule.prompt) {
    logger.debug(
      {
        schedule_id: scheduleId,
        kind: schedule.kind,
        prompt_source: 'schedule_override',
      },
      'skillContentOverrides: using schedule prompt override',
    );
    return { [schedule.kind]: schedule.prompt };
  }

  logger.debug(
    { schedule_id: scheduleId, kind: schedule.kind, prompt_source: 'kind_skill' },
    'skillContentOverrides: using kind skill body',
  );
  return { [schedule.kind]: await resolveScheduleSkillContent(schedule.kind) };
}
