import { childLogger } from '../logger.js';
import { listEnabledSchedules, touchScheduleLastRun } from '../repositories/schedules.js';
import { isCronDue } from '../schedules/cron.js';
import { SCHEDULE_HANDLERS } from '../schedules/handlers.js';

const logger = childLogger('poller');

/** Generic cron trigger: fires the registered kind's handler for every enabled, due schedule row. */
export async function pollSchedules(now: Date = new Date()): Promise<void> {
  for (const row of listEnabledSchedules()) {
    if (!isCronDue(row.cron, now)) continue;

    const handler = SCHEDULE_HANDLERS[row.kind];
    if (!handler) {
      logger.warn(
        { schedule_id: row.id, kind: row.kind },
        'pollSchedules: no handler registered for kind',
      );
      continue;
    }

    try {
      await handler(row);
    } catch (err) {
      logger.error({ err, schedule_id: row.id, kind: row.kind }, 'pollSchedules: handler failed');
    }

    touchScheduleLastRun(row.id);
  }
}
