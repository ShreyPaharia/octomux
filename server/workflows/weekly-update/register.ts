import { registerWorkflow } from '../registry.js';
import { registerScheduleHandler } from '../../schedules/handlers.js';
import { runWeeklyUpdate } from '../../services/weekly-update-service.js';
import { childLogger } from '../../logger.js';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';
import type { WorkflowType } from '../types.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const logger = childLogger('workflows/weekly-update');

export const weeklyUpdateWorkflow: WorkflowType = {
  kind: 'weekly-update',
  displayName: 'Weekly Update',
  surfaces: ['artifact'],
  output: WEEKLY_UPDATE_SCHEMA,
  trigger: { kind: 'cron' },
};

registerWorkflow(weeklyUpdateWorkflow);

async function handleWeeklyUpdateSchedule(row: ScheduleRow): Promise<void> {
  logger.info({ repo_path: row.repo_path, schedule_id: row.id }, 'weekly-update: schedule fired');

  // Fire-and-forget: like overnight-log-summary, runSessionVertical blocks for
  // the full headless agent run inside this process. Awaiting it here would
  // stall pollSchedules' sequential loop for other due schedules, so we let it
  // run in the background and only log failure.
  runWeeklyUpdate({
    repoPath: row.repo_path,
    scheduleId: row.id,
  }).catch((err) => {
    logger.error(
      { err, repo_path: row.repo_path, schedule_id: row.id },
      'weekly-update: run failed',
    );
  });
}

registerScheduleHandler('weekly-update', handleWeeklyUpdateSchedule);
