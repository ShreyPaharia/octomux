import { registerWorkflow } from '../registry.js';
import { runDailyPlanFromSchedule } from './run.js';
import type { RunContext, WorkflowType } from '../types.js';

export const dailyPlanWorkflow: WorkflowType = {
  kind: 'daily-plan',
  displayName: 'Daily Plan',
  surfaces: ['session'],
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => runDailyPlanFromSchedule({ scheduleId: ctx.scheduleId! }),
};

registerWorkflow(dailyPlanWorkflow);
