import { childLogger } from '../logger.js';
import { listEnabledSchedules, touchScheduleLastRun } from '../repositories/schedules.js';
import { isCronDue } from '../schedules/cron.js';
import { getWorkflow } from '../workflows/registry.js';
import { resolveWorkflowConfig } from '../workflows/config.js';

const logger = childLogger('poller');

/** Generic cron trigger: fires the registered kind's `run` for every enabled, due schedule row. */
export async function pollSchedules(now: Date = new Date()): Promise<void> {
  for (const row of listEnabledSchedules()) {
    if (!isCronDue(row.cron, now)) continue;

    const wf = getWorkflow(row.kind);
    if (!wf?.run) {
      logger.warn(
        { schedule_id: row.id, kind: row.kind },
        'pollSchedules: no run handler registered for kind',
      );
      continue;
    }

    const config = resolveWorkflowConfig(wf, row.config_json);

    try {
      await wf.run({
        repoPath: row.repo_path,
        config,
        scheduleId: row.id,
      });
    } catch (err) {
      logger.error({ err, schedule_id: row.id, kind: row.kind }, 'pollSchedules: run failed');
    }

    touchScheduleLastRun(row.id);
  }
}
