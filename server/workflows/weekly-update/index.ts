import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { runWeeklyUpdate } from './run.js';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/weekly-update');

export const weeklyUpdateWorkflow: WorkflowType = {
  kind: 'weekly-update',
  displayName: 'Weekly Update',
  surfaces: ['artifact'],
  execution: 'session',
  output: WEEKLY_UPDATE_SCHEMA,
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'weekly-update: schedule fired',
    );

    void runWeeklyUpdate({
      repoPath: ctx.repoPath,
      scheduleId: ctx.scheduleId,
      trigger: ctx.trigger,
      model: ctx.model,
      timeoutMs: ctx.timeoutMs,
    }).catch((err) => {
      logger.error(
        { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
        'weekly-update: run failed',
      );
    });
    return Promise.resolve();
  },
};

registerWorkflow(weeklyUpdateWorkflow);
