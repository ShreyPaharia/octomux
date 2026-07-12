import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { checkAgentTokenExists } from '../repositories/agent-runtime.js';
import {
  getLoopRun,
  listLoopRuns,
  listIterationsForRun,
  recordEmit,
  terminateLoopRun,
} from '../repositories/loop-runs.js';
import { getTask, setRuntimeState } from '../repositories/tasks.js';
import { badRequest, notFound } from '../services/errors.js';
import { startLoop } from '../task-engine/loop/engine.js';
import type { LoopEmitStatus, LoopSpec } from '../types.js';

const logger = childLogger('routes/loops');

export const router = express.Router();

const EMIT_STATUSES: LoopEmitStatus[] = ['done', 'blocked', 'needs_human'];

/**
 * Authorize a loop emit by its `Authorization: Bearer <hook_token>` header —
 * reuses the same agent hook_token verification as server/hooks.ts.
 */
function requireBearerHookToken(req: Request, res: Response, next: NextFunction): void {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const token = match?.[1];
  if (!token || !checkAgentTokenExists(token)) {
    logger.warn({ path: req.path, ip: req.ip }, 'loop emit: missing or invalid bearer token');
    res.status(401).send();
    return;
  }
  next();
}

router.post('/api/loops', async (req: Request, res: Response) => {
  const body = req.body as { taskId?: unknown; spec?: unknown };
  if (typeof body.taskId !== 'string' || !body.taskId) {
    throw badRequest('taskId is required');
  }
  const spec = body.spec as Partial<LoopSpec> | undefined;
  if (!spec || typeof spec.prompt !== 'string' || !spec.prompt.trim()) {
    throw badRequest('spec.prompt is required');
  }
  if (typeof spec.verify !== 'string' || !spec.verify.trim()) {
    throw badRequest('spec.verify is required');
  }
  if (
    typeof spec.maxIterations !== 'number' ||
    !Number.isFinite(spec.maxIterations) ||
    spec.maxIterations < 1
  ) {
    throw badRequest('spec.maxIterations must be a positive number');
  }

  const task = getTask(body.taskId);
  if (!task) throw notFound('Task not found');

  try {
    const run = await startLoop(body.taskId, spec as LoopSpec);
    res.status(201).json(run);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

router.post('/api/loops/:runId/emit', requireBearerHookToken, (req: Request, res: Response) => {
  const { runId } = req.params as Record<string, string>;
  const run = getLoopRun(runId);
  if (!run) throw notFound('Loop run not found');

  const body = req.body as { status?: unknown; reason?: unknown };
  const status = body.status;
  if (typeof status !== 'string' || !EMIT_STATUSES.includes(status as LoopEmitStatus)) {
    throw badRequest(`status must be one of: ${EMIT_STATUSES.join(', ')}`);
  }
  const reason = body.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw badRequest('reason is required');
  }

  recordEmit(runId, { status: status as LoopEmitStatus, reason });

  logger.info({ task_id: run.task_id, loop_run_id: runId, status }, 'loop emit: recorded');

  broadcast({
    type: 'loop:emit',
    payload: { taskId: run.task_id, loopRunId: runId, status, reason },
  });

  res.status(200).json(getLoopRun(runId));
});

router.post('/api/loops/:runId/stop', (req: Request, res: Response) => {
  const { runId } = req.params as Record<string, string>;
  const run = getLoopRun(runId);
  if (!run) throw notFound('Loop run not found');

  if (run.status === 'running') {
    terminateLoopRun(runId, 'needs_human', 'stopped');
    setRuntimeState(run.task_id, 'idle');
    logger.info({ task_id: run.task_id, loop_run_id: runId }, 'loop: stopped by user');
    broadcast({ type: 'task:updated', payload: { taskId: run.task_id } });
  }

  res.json(getLoopRun(runId));
});

router.get('/api/loops', (_req: Request, res: Response) => {
  res.json(listLoopRuns());
});

router.get('/api/loops/:runId', (req: Request, res: Response) => {
  const { runId } = req.params as Record<string, string>;
  const run = getLoopRun(runId);
  if (!run) throw notFound('Loop run not found');
  res.json({ ...run, iterations: listIterationsForRun(runId) });
});
