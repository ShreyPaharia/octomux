import { registerWorkflow } from '../registry.js';
import { registerScheduleHandler } from '../../schedules/handlers.js';
import { runOvernightLogSummary } from '../../services/overnight-log-summary-service.js';
import { childLogger } from '../../logger.js';
import { OVERNIGHT_LOG_SUMMARY_SCHEMA } from './schema.js';
import type { WorkflowType } from '../types.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const logger = childLogger('workflows/overnight-log-summary');

const DEFAULT_LOG_COMMAND = 'gh run list --limit 30 --json databaseId,conclusion,name,url';

export const overnightLogSummaryWorkflow: WorkflowType = {
  kind: 'overnight-log-summary',
  displayName: 'Overnight Log Summary',
  surfaces: ['artifact'],
  output: OVERNIGHT_LOG_SUMMARY_SCHEMA,
  trigger: { kind: 'cron' },
};

registerWorkflow(overnightLogSummaryWorkflow);

async function handleOvernightLogSummarySchedule(row: ScheduleRow): Promise<void> {
  logger.info(
    { repo_path: row.repo_path, schedule_id: row.id },
    'overnight-log-summary: schedule fired',
  );
  const cfg = row.config_json ? JSON.parse(row.config_json) : {};

  // Fire-and-forget: unlike task/loop verticals, runSessionVertical blocks
  // for the full headless agent run (up to its timeout) inside this process.
  // Awaiting it here would stall pollSchedules' sequential loop for other
  // due schedules, so we let it run in the background and only log failure.
  runOvernightLogSummary({
    repoPath: row.repo_path,
    scheduleId: row.id,
    logCommand: cfg.logCommand ?? DEFAULT_LOG_COMMAND,
  }).catch((err) => {
    logger.error(
      { err, repo_path: row.repo_path, schedule_id: row.id },
      'overnight-log-summary: run failed',
    );
  });
}

registerScheduleHandler('overnight-log-summary', handleOvernightLogSummarySchedule);
