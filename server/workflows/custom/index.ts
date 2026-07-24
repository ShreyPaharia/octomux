import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { runCustom } from './run.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/custom');

export const customWorkflow: WorkflowType = {
  kind: 'custom',
  displayName: 'Custom Prompt',
  surfaces: ['artifact'],
  execution: 'session',
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => {
    logger.info({ repo_path: ctx.repoPath, schedule_id: ctx.scheduleId }, 'custom: schedule fired');

    void runCustom({
      repoPath: ctx.repoPath,
      scheduleId: ctx.scheduleId ?? '',
      model: ctx.model,
      timeoutMs: ctx.timeoutMs,
      trigger: ctx.trigger,
    }).catch((err) => {
      logger.error(
        { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
        'custom: run failed',
      );
    });
    return Promise.resolve();
  },
};

registerWorkflow(customWorkflow);
