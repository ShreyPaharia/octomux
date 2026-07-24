import { listEnabledSchedules } from '../repositories/schedules.js';
import { isCronDue } from '../schedules/cron.js';
import { executeScheduleRun } from './execute-schedule-run.js';

/**
 * Same-minute refire guard: returns true when `last_run_at` falls in the same
 * UTC minute as `now`. This prevents double-fires from poller-tick jitter and
 * DST fall-back (one UTC minute matching twice in a DST overlap).
 *
 * `last_run_at` is stored in SQLite `datetime('now')` format: 'YYYY-MM-DD HH:MM:SS' UTC.
 */
function isSameUtcMinute(last_run_at: string | null, now: Date): boolean {
  if (!last_run_at) return false;
  // Convert 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM' for comparison
  const lastMinute = last_run_at.slice(0, 16).replace(' ', 'T');
  const nowMinute = now.toISOString().slice(0, 16);
  return lastMinute === nowMinute;
}

/** Generic cron trigger: fires the registered kind's `run` for every enabled, due schedule row. */
export async function pollSchedules(now: Date = new Date()): Promise<void> {
  for (const row of listEnabledSchedules()) {
    if (!isCronDue(row.cron, now, row.timezone)) continue;
    if (isSameUtcMinute(row.last_run_at, now)) continue;
    await executeScheduleRun(row.id, { trigger: 'cron' });
  }
}
