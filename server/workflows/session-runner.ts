/**
 * Generic session-vertical runner for `execution: 'session'` schedule kinds —
 * moved from `workflows/custom/run.ts` (spec/schedule-kinds-as-presets.md
 * §4.2) and generalized with a `kind` parameter so `weekly-update`,
 * `overnight-log-summary`, and every home-tier preset (which always forces
 * `session`, §3.3) share one implementation.
 *
 * The schedule row is self-contained (§1): `schedule.prompt` is materialized
 * at create time from the kind's preset, so this reads only the row — no
 * preset lookup, no resolution chain. `{{configKey}}` interpolation against
 * the row's `config_json` is the only templating step.
 *
 * Run-row lifecycle:
 *   - Happy path: runSessionVertical passes `run:` to runAgentSession, which
 *     calls insertRun on entry and finishRun on settle (done or failed). This
 *     function does NOT touch the runs row on the happy path — doing so would
 *     double-insert.
 *   - Empty-prompt path: detected before calling runSessionVertical, so
 *     runAgentSession never runs and never inserts a runs row. We own the row
 *     here: insertRun + finishRun('failed') to prevent a row stuck at 'running'.
 */
import { getSchedule } from '../repositories/schedules.js';
import { insertRun, finishRun } from '../repositories/runs.js';
import { runSessionVertical } from '../services/session-vertical-service.js';
import { interpolatePrompt } from '../prompt-interpolate.js';
import { childLogger } from '../logger.js';
import { getWorkflow } from './registry.js';
import { RUN_RESULT_SCHEMA } from '@octomux/types';
import type { RunResult } from '../types.js';
import type { RunContext } from './types.js';

const logger = childLogger('workflows/session-runner');

/** Fallback output schema for session kinds with no `output` preset field
 * (e.g. `custom`): the universal envelope, closed to extra properties. */
const GENERIC_RUN_RESULT_SCHEMA = {
  ...RUN_RESULT_SCHEMA,
  additionalProperties: false,
};

export interface RunSessionInput extends RunContext {
  kind: string;
}

export async function runSession(input: RunSessionInput): Promise<void> {
  const schedule = input.scheduleId ? getSchedule(input.scheduleId) : undefined;
  const rawPrompt = schedule?.prompt;

  if (!rawPrompt) {
    logger.warn(
      { schedule_id: input.scheduleId, kind: input.kind },
      'session-runner: schedule has no prompt — failing run immediately',
    );
    const run = insertRun({
      workflowKind: input.kind,
      trigger: input.trigger ?? 'cron',
      scheduleId: input.scheduleId,
    });
    finishRun(run.id, {
      status: 'failed',
      result: {
        outcome: 'failed',
        summary: `${input.kind} schedule has no prompt.`,
      } satisfies RunResult,
    });
    return;
  }

  const prompt = interpolatePrompt(rawPrompt, (input.config as Record<string, unknown>) ?? {});
  const outputSchema = getWorkflow(input.kind)?.output ?? GENERIC_RUN_RESULT_SCHEMA;

  await runSessionVertical({
    kind: input.kind,
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema,
    model: input.model,
    timeoutMs: input.timeoutMs,
    trigger: input.trigger ?? 'cron',
  });
}
