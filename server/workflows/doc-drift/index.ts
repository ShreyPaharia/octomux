import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { createDocDriftTaskFromSchedule } from './run.js';
import { DOC_DRIFT_CONFIG_SCHEMA } from './schema.js';
import type { WorkflowType } from '../types.js';
import type { RunContext } from '../types.js';

const logger = childLogger('workflows/doc-drift');

export const docDriftWorkflow: WorkflowType = {
  kind: 'doc-drift',
  displayName: 'Doc Drift',
  surfaces: ['feed', 'artifact'],
  execution: 'task',
  config: DOC_DRIFT_CONFIG_SCHEMA,
  trigger: { kind: 'cron' },
  run: async (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'doc-drift: schedule fired',
    );
    const cfg = ctx.config as {
      verify: string;
      maxIterations: number;
      baseBranch: string;
      branchPrefix: string;
    };
    await createDocDriftTaskFromSchedule({
      repoPath: ctx.repoPath,
      verify: cfg.verify,
      maxIterations: cfg.maxIterations,
      baseBranch: cfg.baseBranch,
      branchPrefix: cfg.branchPrefix,
      model: ctx.model,
      scheduleId: ctx.scheduleId,
      trigger: ctx.trigger,
    });
  },
};

registerWorkflow(docDriftWorkflow);
