/**
 * Service layer for the custom workflow kind — runs a schedule's prompt body
 * as a headless session vertical with the universal RunResult envelope.
 *
 * Run-row lifecycle:
 *   - Happy path: runSessionVertical passes `run:` to runAgentSession, which
 *     calls insertRun on entry and finishRun on settle (done or failed). This
 *     wrapper does NOT touch the runs row on the happy path — doing so would
 *     double-insert, mirroring the weekly-update pattern exactly.
 *   - Empty-prompt path: we detect the missing prompt before calling
 *     runSessionVertical, so runAgentSession never runs and never inserts a
 *     runs row. We own the row here: insertRun + finishRun('failed') to
 *     prevent a row stuck at 'running'. We then return without calling
 *     runSessionVertical.
 */

import { getSchedule } from '../../repositories/schedules.js';
import { insertRun, finishRun } from '../../repositories/runs.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { interpolatePrompt } from '../../prompt-interpolate.js';
import { childLogger } from '../../logger.js';
import { RUN_RESULT_SCHEMA } from '@octomux/types';
import type { RunResult } from '../../types.js';

const logger = childLogger('workflows/custom');

/** Output schema: RUN_RESULT_SCHEMA plus additionalProperties: false. */
const CUSTOM_SCHEMA = {
  ...RUN_RESULT_SCHEMA,
  additionalProperties: false,
};

export interface RunCustomInput {
  repoPath: string;
  scheduleId: string;
  model?: string | null;
  timeoutMs?: number | null;
  trigger?: 'cron' | 'manual';
}

export async function runCustom(input: RunCustomInput): Promise<void> {
  const schedule = getSchedule(input.scheduleId);
  const rawPrompt = schedule?.prompt;

  if (!rawPrompt) {
    logger.warn(
      { schedule_id: input.scheduleId },
      'custom: schedule has no prompt — failing run immediately',
    );
    const run = insertRun({
      workflowKind: 'custom',
      trigger: input.trigger ?? 'cron',
      scheduleId: input.scheduleId,
    });
    finishRun(run.id, {
      status: 'failed',
      result: {
        outcome: 'failed',
        summary: 'Custom schedule has no prompt.',
      } satisfies RunResult,
    });
    return;
  }

  // Interpolate extras only (no config on custom kind in v1).
  const prompt = interpolatePrompt(rawPrompt, {});

  await runSessionVertical({
    kind: 'custom',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: CUSTOM_SCHEMA,
    model: input.model,
    timeoutMs: input.timeoutMs,
    trigger: input.trigger ?? 'cron',
  });
}
