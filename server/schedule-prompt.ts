/**
 * Overrides passed into harness plugin flags for task-backed scheduled runs so
 * the agent reads the schedule's prompt via an ephemeral overlay plugin
 * (`writeOverlayPlugin` in `octomux-plugin.ts`) — with the six shipped
 * `SKILL.md` files gone (spec/schedule-kinds-as-presets.md §4.1), this overlay
 * is the only delivery path for task-backed prompts, not an "override" over a
 * skill file. The schedule row is self-contained (`schedules.prompt` is
 * copied from the kind's preset at create time, §1), so there is no
 * resolution chain left — just a read.
 */
import { getSchedule } from './repositories/schedules.js';

/**
 * Plugin skill-content override for a scheduled task-backed run: the
 * schedule's own prompt, keyed by kind, or `undefined` when the schedule has
 * no prompt (or doesn't exist).
 */
export function skillContentOverridesForScheduleId(
  scheduleId: string | null | undefined,
): Record<string, string> | undefined {
  const schedule = scheduleId ? getSchedule(scheduleId) : null;
  return schedule?.prompt ? { [schedule.kind]: schedule.prompt } : undefined;
}
