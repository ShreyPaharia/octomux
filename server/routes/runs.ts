/**
 * server/routes/runs.ts
 *
 * The generic `runs` HTTP surface — replaces the 10 loop/loop-group routes
 * that used to live in routes/loops.ts and routes/loop-groups.ts (both
 * deleted) with 4 hand-written ones here, plus a 5th (`POST /api/runs/:id/emit`)
 * that migrated to the capability registry (server/registry/capabilities/run.ts)
 * since it's bearer-gated and the registry can now express that
 * (`HttpProjection.auth: 'bearer-hook-token'`).
 *
 *   GET  /api/runs?kind=       list (unchanged)
 *   GET  /api/runs/:id         NEW — polymorphic detail (server/services/run-detail.ts)
 *   POST /api/runs             NEW — dispatches on body.workflowKind: 'loop' | 'loop-group' | 'judge'
 *   POST /api/runs/:id/stop    NEW — cancel (loop or loop-group)
 *   POST /api/runs/:id/emit    → capability, see server/registry/capabilities/run.ts
 *
 * The OLD `POST /api/loop-groups/:id/judge` (launch the best-of-N judge task —
 * distinct from `:id/judge/emit`, which RECORDS the judge's verdict) folds into
 * `POST /api/runs` as a third `workflowKind: 'judge'` branch rather than a 6th
 * route: launching the judge is "start a new piece of work" (a judge task, its
 * own tmux session and agent) exactly like starting a loop or a loop-group is,
 * even though — unlike those two — it advances an EXISTING loop-group run's
 * `judge_status` rather than inserting a new `runs` row. Responds 202
 * (Accepted), matching the route it replaces, not 201.
 *
 * Why POST /api/runs/emit/stop are NOT capabilities: `POST /api/runs` dispatches
 * to one of three structurally different flows (single loop, best-of-N group,
 * launch-judge) with discriminated required fields per branch, and `POST /api/runs/:id/stop`
 * fans out over a group's live candidates — both are naturally expressed as
 * hand-written control flow reusing the same validation/service calls the old
 * routes used, not a single flat zod-validated input. `GET /api/runs/:id` stays
 * alongside them for symmetry (a capability-only detail route next to
 * hand-written siblings on the same resource would be a maintenance trap: same
 * resource, split across two systems for no behavioural reason). `emit` is the
 * one exception — it already had exactly this auth wrinkle solved for the
 * `learning.*` capabilities (server/registry/capabilities/learning.ts), so it
 * reuses that pattern instead of duplicating `requireBearerHookToken` by hand.
 *
 * Run-adoption fix (the reason this collapse was safe to do at all): a loop
 * started via the old `POST /api/loops` never got a `runs` row — only
 * doc-drift/prod-log-triage pre-created one and threaded its id through
 * `LoopSpec.runId`. `POST /api/runs` (below) and
 * `services/loop-group-service.ts`'s `createLoopGroupWithCandidates` now both
 * call `insertRun` the same way, so every loop — manual or best-of-N — gets a
 * `runs` row and shows up in `GET /api/runs`.
 *
 * Id namespace: every id in this file's URLs is a `runs.id`, not a
 * `loop_runs.id` or `loop_groups.id` — see `task-engine/loop/engine.ts`'s
 * `loopRunIdLines` call sites and `services/loop-group-service.ts`'s
 * `buildJudgePrompt` for where that id gets baked into a live agent prompt.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import {
  listRunsForWorkflow,
  countRunsForWorkflow,
  listAllRuns,
  insertRun,
  finishRun,
  getRun,
} from '../repositories/runs.js';
import { listWorkflows } from '../workflows/registry.js';
import { getRunDetail } from '../services/run-detail.js';
import { getTask, setRuntimeState } from '../repositories/tasks.js';
import {
  getActiveLoopRunForTask,
  getLoopRun,
  terminateLoopRun,
} from '../repositories/loop-runs.js';
import { getLoopGroupByRunId, listLoopRunsForGroup } from '../repositories/loop-groups.js';
import { startLoop } from '../task-engine/loop/engine.js';
import { createLoopGroupWithCandidates, launchJudge } from '../services/loop-group-service.js';
import { badRequest, conflict, notFound } from '../services/errors.js';
import type { LoopSpec } from '../types.js';

const logger = childLogger('routes/runs');

export const router = express.Router();

// ─── GET /api/runs, GET /api/workflows (unchanged) ────────────────────────────

router.get('/api/runs', (req: Request, res: Response) => {
  const { kind } = req.query as Record<string, string>;
  res.json({ runs: kind ? listRunsForWorkflow(kind) : listAllRuns() });
});

router.get('/api/workflows', (_req: Request, res: Response) => {
  res.json({
    workflows: listWorkflows().map((w) => ({
      kind: w.kind,
      displayName: w.displayName,
      surfaces: w.surfaces,
      trigger: w.trigger ?? null,
      config: w.config ?? null,
      output: w.output ?? null,
      runCount: countRunsForWorkflow(w.kind),
    })),
  });
});

// ─── GET /api/runs/:id ──────────────────────────────────────────────────────

router.get('/api/runs/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const detail = getRunDetail(id);
  if (!detail) throw notFound('Run not found');
  res.json(detail);
});

// ─── POST /api/runs ─────────────────────────────────────────────────────────

export interface CreateLoopRunBody {
  workflowKind: 'loop';
  taskId?: unknown;
  spec?: unknown;
}

interface CreateLoopGroupRunBody {
  workflowKind: 'loop-group';
  repoPath?: unknown;
  baseBranch?: unknown;
  spec?: unknown;
  n?: unknown;
}

function validateLoopSpec(spec: unknown): LoopSpec {
  const s = spec as Partial<LoopSpec> | undefined;
  if (!s || typeof s.prompt !== 'string' || !s.prompt.trim()) {
    throw badRequest('spec.prompt is required');
  }
  if (typeof s.verify !== 'string' || !s.verify.trim()) {
    throw badRequest('spec.verify is required');
  }
  if (
    typeof s.maxIterations !== 'number' ||
    !Number.isFinite(s.maxIterations) ||
    s.maxIterations < 1
  ) {
    throw badRequest('spec.maxIterations must be a positive number');
  }
  return s as LoopSpec;
}

export async function createLoopRun(body: CreateLoopRunBody): Promise<string> {
  if (typeof body.taskId !== 'string' || !body.taskId) {
    throw badRequest('taskId is required');
  }
  const spec = validateLoopSpec(body.spec);

  const task = getTask(body.taskId);
  if (!task) throw notFound('Task not found');

  const activeRun = getActiveLoopRunForTask(body.taskId);
  if (task.runtime_state === 'looping' || activeRun?.status === 'running') {
    throw conflict('task already has an active loop run');
  }

  const loopRunId = nanoid(12);
  const runsRow = insertRun({
    workflowKind: 'loop',
    trigger: 'manual',
    taskId: body.taskId,
    loopRunId,
  });

  try {
    await startLoop(body.taskId, { ...spec, runId: runsRow.id }, undefined, loopRunId);
  } catch (err) {
    // The runs row already exists (status='running') — close it out rather than
    // leaving an orphan behind, mirroring doc-drift/prod-log-triage's M1 guard.
    finishRun(runsRow.id, {
      status: 'failed',
      error: (err as Error).message,
      result: { outcome: 'failed', summary: (err as Error).message },
    });
    throw badRequest((err as Error).message);
  }

  return runsRow.id;
}

const MIN_N = 2;
const MAX_N = 8;

async function createLoopGroupRun(body: CreateLoopGroupRunBody): Promise<string> {
  if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    throw badRequest('repoPath is required');
  }
  if (typeof body.baseBranch !== 'string' || !body.baseBranch.trim()) {
    throw badRequest('baseBranch is required');
  }
  const spec = validateLoopSpec(body.spec);
  if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < MIN_N || body.n > MAX_N) {
    throw badRequest(`n must be an integer between ${MIN_N} and ${MAX_N}`);
  }

  const { group } = await createLoopGroupWithCandidates({
    repoPath: body.repoPath,
    baseBranch: body.baseBranch,
    spec,
    n: body.n,
    trigger: 'manual',
  });

  logger.info({ loop_group_id: group.id, run_id: group.run_id, n: body.n }, 'loop_group: created');
  return group.run_id as string;
}

interface LaunchJudgeBody {
  workflowKind: 'judge';
  /** The loop-group's own `runs.id` (the `POST /api/runs` `{workflowKind:'loop-group'}` response's `id`). */
  runId?: unknown;
}

async function launchJudgeRun(body: LaunchJudgeBody): Promise<string> {
  if (typeof body.runId !== 'string' || !body.runId) {
    throw badRequest('runId is required');
  }
  const run = getRun(body.runId);
  if (!run) throw notFound('Run not found');
  if (run.workflow_kind !== 'loop-group') {
    throw badRequest('run is not a loop-group run');
  }
  const group = getLoopGroupByRunId(run.id);
  if (!group) throw notFound('Loop group not found');

  await launchJudge(group.id);
  broadcast({ type: 'loop_group:judging', payload: { groupId: group.id, runId: run.id } });
  return run.id;
}

router.post('/api/runs', async (req: Request, res: Response) => {
  const body = req.body as { workflowKind?: unknown };

  if (body.workflowKind === 'judge') {
    const runId = await launchJudgeRun(body as LaunchJudgeBody);
    res.status(202).json(getRunDetail(runId));
    return;
  }

  let runId: string;
  if (body.workflowKind === 'loop') {
    runId = await createLoopRun(body as CreateLoopRunBody);
  } else if (body.workflowKind === 'loop-group') {
    runId = await createLoopGroupRun(body as CreateLoopGroupRunBody);
  } else {
    throw badRequest("workflowKind must be one of: 'loop', 'loop-group', 'judge'");
  }

  res.status(201).json(getRunDetail(runId));
});

// ─── POST /api/runs/:id/stop ────────────────────────────────────────────────

router.post('/api/runs/:id/stop', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const run = getRun(id);
  if (!run) throw notFound('Run not found');

  if (run.workflow_kind === 'loop-group') {
    const group = getLoopGroupByRunId(id);
    if (group) {
      for (const candidate of listLoopRunsForGroup(group.id)) {
        if (candidate.status !== 'running') continue;
        terminateLoopRun(candidate.id, 'needs_human', 'stopped');
        setRuntimeState(candidate.task_id, 'idle');
        broadcast({ type: 'task:updated', payload: { taskId: candidate.task_id } });
      }
      logger.info({ loop_group_id: group.id, run_id: id }, 'loop_group: stopped by user');
    }
  } else if (run.loop_run_id) {
    const loopRun = getLoopRun(run.loop_run_id);
    if (loopRun && loopRun.status === 'running') {
      terminateLoopRun(loopRun.id, 'needs_human', 'stopped');
      setRuntimeState(loopRun.task_id, 'idle');
      logger.info(
        { task_id: loopRun.task_id, loop_run_id: loopRun.id, run_id: id },
        'loop: stopped by user',
      );
      broadcast({ type: 'task:updated', payload: { taskId: loopRun.task_id } });
    }
  }

  if (run.status === 'running') {
    finishRun(id, {
      status: 'blocked',
      result: { outcome: 'blocked', summary: 'Stopped by user' },
    });
  }

  res.json(getRunDetail(id));
});
