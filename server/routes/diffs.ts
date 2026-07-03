import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import {
  parseDiffRange,
  resolveDiffBase,
  resolveRef,
  safeResolvePath,
  getDiffSummary,
  getFileDiff,
  clearDiffBaseCache,
} from '@octomux/diff-engine';
import { childLogger } from '../logger.js';
import { taskWorkingDir } from '../task-paths.js';
import { decorateDiffSummaryWithReviewState } from '../diff-review-state.js';
import { listBranches, listCommits } from '../git-commits.js';
import { setWorktreeBase } from '../repositories/index.js';
import { touchUpdatedAt, getTask as getTaskRepo } from '../repositories/index.js';
import { broadcast } from '../events.js';
import { loadTaskOrFail } from './_shared.js';
import { badRequest, conflict } from '../services/errors.js';

const logger = childLogger('api:diffs');
const diffLogger = childLogger('diff');

function requireDiffTask(req: Request) {
  const task = loadTaskOrFail(req);
  if (task.run_mode === 'scratch') {
    throw badRequest('no repo for scratch task');
  }
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    throw badRequest('Task has no worktree');
  }
  if (!task.base_sha) {
    throw badRequest('base_sha not available for this task');
  }
  if (!fs.existsSync(cwd)) {
    throw badRequest('Worktree no longer exists on disk');
  }
  return { task, cwd };
}

function requireUsableWorktree(req: Request) {
  const task = loadTaskOrFail(req);
  if (task.run_mode === 'scratch') {
    throw badRequest('no repo for scratch task');
  }
  const cwd = taskWorkingDir(task);
  if (!cwd || !fs.existsSync(cwd)) {
    throw badRequest('Task has no usable worktree');
  }
  return { task, cwd };
}

function parseRangeOrThrow(queryRange: string | undefined) {
  try {
    return parseDiffRange(queryRange);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

export const router = express.Router();

router.get('/api/tasks/:id/diff', async (req: Request, res: Response) => {
  const { task, cwd } = requireDiffTask(req);
  const range = parseRangeOrThrow(
    typeof req.query.range === 'string' ? req.query.range : undefined,
  );
  const summary = await getDiffSummary({ target: task, range, logger: diffLogger });
  const decorated = await decorateDiffSummaryWithReviewState(task.id, cwd, summary);
  res.json(decorated);
});

router.get('/api/tasks/:id/diff/*path', async (req: Request, res: Response) => {
  const { task, cwd } = requireDiffTask(req);
  const params = req.params as Record<string, string | string[]>;
  const rawPath = params.path ?? params['0'] ?? '';
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  try {
    safeResolvePath(cwd, relPath);
  } catch {
    throw badRequest('Invalid path');
  }
  const range = parseRangeOrThrow(
    typeof req.query.range === 'string' ? req.query.range : undefined,
  );
  const resolved = await resolveDiffBase(task);
  const diff = await getFileDiff({
    worktree: cwd,
    range,
    taskBaseSha: resolved.sha,
    relPath,
  });
  res.json(diff);
});

router.get('/api/tasks/:id/branches', async (req: Request, res: Response) => {
  const { task, cwd } = requireUsableWorktree(req);
  try {
    const result = await listBranches(cwd);
    res.json(result);
  } catch (err) {
    logger.warn({ task_id: task.id, err: (err as Error).message }, 'listBranches failed');
    throw err;
  }
});

router.get('/api/tasks/:id/commits', async (req: Request, res: Response) => {
  const { task, cwd } = requireUsableWorktree(req);

  let from: string | undefined;
  let to = 'HEAD';
  const rangeParam = typeof req.query.range === 'string' ? req.query.range : undefined;
  if (rangeParam) {
    const parsed = parseRangeOrThrow(rangeParam);
    switch (parsed.kind) {
      case 'base':
        from = task.base_sha ?? undefined;
        to = 'HEAD';
        break;
      case 'commit':
        from = `${parsed.sha}^`;
        to = parsed.sha;
        break;
      case 'range':
        from = parsed.from;
        to = parsed.to;
        break;
      case 'working':
        res.json({ commits: [], truncated: false });
        return;
    }
  } else if (task.base_sha) {
    from = task.base_sha;
  }

  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000);

  try {
    const result = await listCommits(cwd, { from, to, limit });
    res.json(result);
  } catch (err) {
    logger.warn({ task_id: task.id, err: (err as Error).message }, 'listCommits failed');
    throw err;
  }
});

router.patch('/api/tasks/:id/base', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  if (task.run_mode === 'scratch') {
    throw badRequest('no repo for scratch task');
  }
  if (task.runtime_state === 'idle') {
    throw conflict('cannot change base on a draft task');
  }
  if (!task.worktree_id) {
    throw badRequest('task has no worktree row to update');
  }
  const cwd = taskWorkingDir(task);
  if (!cwd || !fs.existsSync(cwd)) {
    throw badRequest('Task has no usable worktree');
  }

  const baseBranch = (req.body as { base_branch?: unknown }).base_branch;
  if (typeof baseBranch !== 'string' || !baseBranch.trim()) {
    throw badRequest('base_branch is required');
  }

  let sha: string;
  try {
    sha = await resolveRef(cwd, baseBranch);
  } catch (err) {
    logger.warn(
      { task_id: task.id, base_branch: baseBranch, err: (err as Error).message },
      'resolveRef failed',
    );
    throw badRequest('ref does not resolve');
  }

  setWorktreeBase(task.worktree_id, baseBranch, sha);
  touchUpdatedAt(task.id);

  if (task.base_branch) clearDiffBaseCache(cwd, task.base_branch);
  clearDiffBaseCache(cwd, baseBranch);

  logger.info({ task_id: task.id, base_branch: baseBranch, base_sha: sha }, 'task base changed');

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });

  const reloaded = getTaskRepo(task.id);
  res.json(reloaded);
});
