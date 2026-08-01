import { childLogger } from '../logger.js';
import { getSchedule, touchScheduleLastRun } from '../repositories/schedules.js';
import { getWorkflow } from '../workflows/registry.js';
import { resolveWorkflowConfig } from '../workflows/config.js';
import type { RunContext } from '../workflows/types.js';

const logger = childLogger('poller');

export type ScheduleRunTrigger = NonNullable<RunContext['trigger']>;

/** Shared entry point for cron poller and manual "run now" — one run path. */
export async function executeScheduleRun(
  scheduleId: string,
  options?: { trigger?: ScheduleRunTrigger },
): Promise<void> {
  const row = getSchedule(scheduleId);
  if (!row) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  const wf = getWorkflow(row.kind);
  if (!wf?.run) {
    logger.warn(
      { schedule_id: row.id, kind: row.kind },
      'executeScheduleRun: no run handler registered for kind',
    );
    return;
  }

  const config = resolveWorkflowConfig(row.config_json);
  const trigger = options?.trigger ?? 'cron';

  logger.info(
    {
      schedule_id: row.id,
      kind: row.kind,
      trigger,
      model: row.model ?? 'default',
      timeout_ms: row.timeout_ms ?? 300000,
    },
    'schedule run started',
  );

  try {
    await wf.run({
      repoPath: row.repo_path,
      config,
      scheduleId: row.id,
      trigger,
      model: row.model ?? null,
      timeoutMs: row.timeout_ms ?? null,
    });
  } catch (err) {
    logger.error({ err, schedule_id: row.id, kind: row.kind }, 'executeScheduleRun: run failed');
  }

  touchScheduleLastRun(row.id);
}
