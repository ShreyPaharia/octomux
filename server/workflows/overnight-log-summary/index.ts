import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { runSession } from '../session-runner.js';
import { OVERNIGHT_LOG_SUMMARY_CONFIG_SCHEMA, OVERNIGHT_LOG_SUMMARY_SCHEMA } from './schema.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/overnight-log-summary');

export const overnightLogSummaryWorkflow: WorkflowType = {
  kind: 'overnight-log-summary',
  displayName: 'Overnight Log Summary',
  surfaces: ['artifact'],
  execution: 'session',
  config: OVERNIGHT_LOG_SUMMARY_CONFIG_SCHEMA,
  output: OVERNIGHT_LOG_SUMMARY_SCHEMA,
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'overnight-log-summary: schedule fired',
    );

    // Fire-and-forget: runSession blocks for the full headless agent run.
    void runSession({ ...ctx, kind: 'overnight-log-summary' }).catch((err) => {
      logger.error(
        { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
        'overnight-log-summary: run failed',
      );
    });
    return Promise.resolve();
  },
};

registerWorkflow(overnightLogSummaryWorkflow);
