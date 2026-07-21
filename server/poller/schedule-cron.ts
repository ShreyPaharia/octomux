import { listEnabledSchedules } from '../repositories/schedules.js';
import { isCronDue } from '../schedules/cron.js';
import { executeScheduleRun } from './execute-schedule-run.js';

/** Generic cron trigger: fires the registered kind's `run` for every enabled, due schedule row. */
export async function pollSchedules(now: Date = new Date()): Promise<void> {
  for (const row of listEnabledSchedules()) {
    if (!isCronDue(row.cron, now)) continue;
    await executeScheduleRun(row.id, { trigger: 'cron' });
  }
}
