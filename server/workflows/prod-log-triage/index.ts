import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { createTriageTaskFromSchedule } from './run.js';
import { PROD_LOG_TRIAGE_CONFIG_SCHEMA } from './schema.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/prod-log-triage');

export const prodLogTriageWorkflow: WorkflowType = {
  kind: 'prod-log-triage',
  displayName: 'Prod Log Triage',
  surfaces: ['feed', 'artifact'],
  config: PROD_LOG_TRIAGE_CONFIG_SCHEMA,
  trigger: { kind: 'cron' },
  run: async (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'prod-log-triage: schedule fired',
    );
    const cfg = ctx.config as { logCommand: string; verify: string; maxIterations: number };
    await createTriageTaskFromSchedule({
      repoPath: ctx.repoPath,
      logCommand: cfg.logCommand,
      verify: cfg.verify,
      maxIterations: cfg.maxIterations,
      scheduleId: ctx.scheduleId,
    });
  },
};

registerWorkflow(prodLogTriageWorkflow);
