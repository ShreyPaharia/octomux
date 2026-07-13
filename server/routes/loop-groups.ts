import express from 'express';
import type { Request, Response } from 'express';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { requireBearerHookToken } from './hook-auth.js';
import {
  getLoopGroup,
  listLoopGroups,
  listLoopRunsForGroup,
  recordJudgeResult,
} from '../repositories/loop-groups.js';
import { createLoopGroupWithCandidates, launchJudge } from '../services/loop-group-service.js';
import { badRequest, notFound } from '../services/errors.js';
import type { LoopSpec } from '../types.js';

const logger = childLogger('routes/loop-groups');

export const router = express.Router();

const MIN_N = 2;
const MAX_N = 8;

router.post('/api/loop-groups', async (req: Request, res: Response) => {
  const body = req.body as {
    repoPath?: unknown;
    baseBranch?: unknown;
    spec?: unknown;
    n?: unknown;
  };

  if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    throw badRequest('repoPath is required');
  }
  if (typeof body.baseBranch !== 'string' || !body.baseBranch.trim()) {
    throw badRequest('baseBranch is required');
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
  if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < MIN_N || body.n > MAX_N) {
    throw badRequest(`n must be an integer between ${MIN_N} and ${MAX_N}`);
  }

  const { group, loopRuns } = await createLoopGroupWithCandidates({
    repoPath: body.repoPath,
    baseBranch: body.baseBranch,
    spec: spec as LoopSpec,
    n: body.n,
  });

  logger.info({ loop_group_id: group.id, n: body.n }, 'loop_group: created via API');
  res.status(201).json({ ...group, loopRuns });
});

router.get('/api/loop-groups', (_req: Request, res: Response) => {
  res.json(listLoopGroups());
});

router.get('/api/loop-groups/:id', (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const group = getLoopGroup(id);
  if (!group) throw notFound('Loop group not found');
  res.json({ ...group, loopRuns: listLoopRunsForGroup(id) });
});

router.post('/api/loop-groups/:id/judge', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const group = await launchJudge(id);
  broadcast({ type: 'loop_group:judging', payload: { groupId: id } });
  res.status(202).json(group);
});

router.post(
  '/api/loop-groups/:id/judge/emit',
  requireBearerHookToken,
  (req: Request, res: Response) => {
    const { id } = req.params as Record<string, string>;
    const group = getLoopGroup(id);
    if (!group) throw notFound('Loop group not found');

    const body = req.body as { winnerLoopRunId?: unknown; rationale?: unknown };
    if (typeof body.winnerLoopRunId !== 'string' || !body.winnerLoopRunId) {
      throw badRequest('winnerLoopRunId is required');
    }
    if (typeof body.rationale !== 'string' || !body.rationale.trim()) {
      throw badRequest('rationale is required');
    }
    const memberIds = listLoopRunsForGroup(id).map((r) => r.id);
    if (!memberIds.includes(body.winnerLoopRunId)) {
      throw badRequest('winnerLoopRunId is not a candidate in this group');
    }

    recordJudgeResult(id, body.winnerLoopRunId, body.rationale);
    logger.info(
      { loop_group_id: id, winner_loop_run_id: body.winnerLoopRunId },
      'loop_group: judge emit recorded',
    );
    broadcast({ type: 'loop_group:judged', payload: { groupId: id } });
    res.status(200).json(getLoopGroup(id));
  },
);
