/**
 * server/registry/capabilities/run.ts
 *
 * Handler for `run.emit` — the ONE capability the loop/loop-group route
 * collapse produced (see `server/routes/runs.ts`'s module doc for the full
 * before/after route list and why the other 4 new routes stayed hand-written).
 *
 * Discriminates its body shape by the target run's `workflow_kind`, resolved
 * from the `:id` path param (a `runs.id`):
 *  - loop-backed (`workflow_kind` 'loop', 'doc-drift', 'prod-log-triage', or
 *    anything else with `runs.loop_run_id` set) → `{status, reason}`, mirrors
 *    the OLD `POST /api/loops/:runId/emit` (routes/loops.ts, deleted) exactly:
 *    same status enum, same `recordEmit` call, same `loop:emit` broadcast.
 *  - `workflow_kind === 'loop-group'` → `{winnerLoopRunId, rationale}`, mirrors
 *    the OLD `POST /api/loop-groups/:id/judge/emit` (routes/loop-groups.ts,
 *    deleted) exactly: same membership check, same `recordJudgeResult` call,
 *    same `loop_group:judged` broadcast — PLUS `finishRun` on the group's own
 *    `runs` row (the old route never had one to finish; see
 *    services/loop-group-service.ts's adoption-fix doc comment).
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3 (loop/loop-group collapse)
 */

import { z } from 'zod';
import { RUN_CAPABILITY_META, runEmitInputSchema } from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
import { defineCapability } from '../index.js';
import { broadcast } from '../../events.js';
import { getRunWithEffectiveStatus, finishRun } from '../../repositories/runs.js';
import { getLoopRun, recordEmit } from '../../repositories/loop-runs.js';
import {
  getLoopGroupByRunId,
  listLoopRunsForGroup,
  recordJudgeResult,
} from '../../repositories/loop-groups.js';
import { getRunDetail } from '../../services/run-detail.js';
import { badRequest, notFound } from '../../services/errors.js';
import { childLogger } from '../../logger.js';
import type { LoopEmitStatus } from '../../types.js';

const logger = childLogger('registry/capabilities/run');

const EMIT_STATUSES: LoopEmitStatus[] = ['done', 'blocked', 'needs_human'];

async function emitJudgeVerdict(
  runId: string,
  groupId: string,
  input: { winnerLoopRunId?: unknown; rationale?: unknown },
) {
  const winnerLoopRunId = input.winnerLoopRunId;
  if (typeof winnerLoopRunId !== 'string' || !winnerLoopRunId) {
    throw badRequest('winnerLoopRunId is required');
  }
  const rationale = input.rationale;
  if (typeof rationale !== 'string' || !rationale.trim()) {
    throw badRequest('rationale is required');
  }
  const memberIds = listLoopRunsForGroup(groupId).map((r) => r.id);
  if (!memberIds.includes(winnerLoopRunId)) {
    throw badRequest('winnerLoopRunId is not a candidate in this group');
  }

  recordJudgeResult(groupId, winnerLoopRunId, rationale);
  finishRun(runId, {
    status: 'done',
    result: { outcome: 'done', summary: rationale },
  });
  logger.info(
    { loop_group_id: groupId, run_id: runId, winner_loop_run_id: winnerLoopRunId },
    'loop_group: judge emit recorded',
  );
  broadcast({ type: 'loop_group:judged', payload: { groupId, runId } });
}

function emitLoopStatus(
  runId: string,
  loopRunId: string,
  input: { status?: unknown; reason?: unknown },
) {
  const status = input.status;
  if (typeof status !== 'string' || !EMIT_STATUSES.includes(status as LoopEmitStatus)) {
    throw badRequest(`status must be one of: ${EMIT_STATUSES.join(', ')}`);
  }
  const reason = input.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw badRequest('reason is required');
  }

  const loopRun = getLoopRun(loopRunId);
  if (!loopRun) throw notFound('Loop run not found');

  recordEmit(loopRunId, { status: status as LoopEmitStatus, reason });
  logger.info(
    { task_id: loopRun.task_id, loop_run_id: loopRunId, run_id: runId, status },
    'loop emit: recorded',
  );
  broadcast({
    type: 'loop:emit',
    payload: { taskId: loopRun.task_id, runId, loopRunId, status, reason },
  });
}

async function emitHandler(input: z.infer<typeof runEmitInputSchema>) {
  const run = getRunWithEffectiveStatus(input.id);
  if (!run) throw notFound('Run not found');

  if (run.workflow_kind === 'loop-group') {
    const group = getLoopGroupByRunId(run.id);
    if (!group) throw notFound('Loop group not found');
    await emitJudgeVerdict(run.id, group.id, input);
  } else {
    if (!run.loop_run_id) throw badRequest('run is not loop-backed');
    emitLoopStatus(run.id, run.loop_run_id, input);
  }

  return getRunDetail(run.id);
}

function findMeta<TInput>(id: string, _schema: z.ZodType<TInput>): CapabilityMeta<TInput> {
  const meta = RUN_CAPABILITY_META.find((m) => m.id === id);
  if (!meta) throw new Error(`registry: missing capability metadata for '${id}'`);
  return meta as CapabilityMeta<TInput>;
}

export function registerRunCapabilities(): void {
  defineCapability({
    ...findMeta('run.emit', runEmitInputSchema),
    handler: emitHandler,
  });
}
