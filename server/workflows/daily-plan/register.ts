import { registerWorkflow } from '../registry.js';
import { registerScheduleHandler } from '../../schedules/handlers.js';
import { runDailyPlanFromSchedule } from '../../services/daily-plan-service.js';
import type { WorkflowType } from '../types.js';

export const dailyPlanWorkflow: WorkflowType = {
  kind: 'daily-plan',
  displayName: 'Daily Plan',
  surfaces: ['session'],
  trigger: { kind: 'cron' },
};

registerWorkflow(dailyPlanWorkflow);

// createChat is a quick spawn (tmux + prompt), not a long-running blocking
// agent session, so unlike overnight-log-summary/weekly-update we let
// pollSchedules await this directly — its own try/catch already handles
// failures without stalling other due schedules.
registerScheduleHandler('daily-plan', (row) => runDailyPlanFromSchedule({ scheduleId: row.id }));
