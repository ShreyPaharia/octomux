import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import {
  BaseBranchMissingError,
  BaseUnavailableError,
  clearDiffBaseCache,
  getDiffSummary,
  getFileDiff,
  parseDiffRange,
  resolveDiffBase,
  resolveRef,
  safeResolvePath,
} from '@octomux/diff-engine';
import { childLogger } from '../logger.js';
import { taskWorkingDir } from '../task-paths.js';
import { decorateDiffSummaryWithReviewState } from '../diff-review-state.js';
import { listBranches, listCommits } from '../git-commits.js';
import { setWorktreeBase } from '../repositories/index.js';
import { touchUpdatedAt, getTask as getTaskRepo } from '../repositories/index.js';
import { broadcast } from '../events.js';
import { loadTaskOrFail } from './_shared.js';

const logger = childLogger('api:diffs');
const diffLogger = childLogger('diff');

export const router = express.Router();

// GET /api/tasks/:id/diff — get diff summary for a task
router.get('/api/tasks/:id/diff', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    res.status(400).json({ error: 'Task has no worktree' });
    return;
  }
  if (!task.base_sha) {
    res.status(400).json({ error: 'base_sha not available for this task' });
    return;
  }
  if (!fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Worktree no longer exists on disk' });
    return;
  }
  let range;
  try {
    range = parseDiffRange(typeof req.query.range === 'string' ? req.query.range : undefined);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const summary = await getDiffSummary({ target: task, range, logger: diffLogger });
    const decorated = await decorateDiffSummaryWithReviewState(task.id, cwd, summary);
    res.json(decorated);
  } catch (err) {
    if (err instanceof BaseBranchMissingError) {
      res.status(422).json({ error: 'base_branch_missing', message: err.message });
      return;
    }
    if (err instanceof BaseUnavailableError) {
      res.status(503).json({ error: 'base_unavailable', message: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/tasks/:id/diff/*path — get per-file diff
router.get('/api/tasks/:id/diff/*path', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    res.status(400).json({ error: 'Task has no worktree' });
    return;
  }
  if (!task.base_sha) {
    res.status(400).json({ error: 'base_sha not available for this task' });
    return;
  }
  if (!fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Worktree no longer exists on disk' });
    return;
  }
  const params = req.params as Record<string, string | string[]>;
  const rawPath = params.path ?? params['0'] ?? '';
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  try {
    safeResolvePath(cwd, relPath);
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  let range;
  try {
    range = parseDiffRange(typeof req.query.range === 'string' ? req.query.range : undefined);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    // Resolve the live base so the per-file diff agrees with the summary
    // (both go through resolveDiffBase, which shares an in-process cache).
    const resolved = await resolveDiffBase(task);
    const diff = await getFileDiff({
      worktree: cwd,
      range,
      taskBaseSha: resolved.sha,
      relPath,
    });
    res.json(diff);
  } catch (err) {
    if (err instanceof BaseBranchMissingError) {
      res.status(422).json({ error: 'base_branch_missing', message: err.message });
      return;
    }
    if (err instanceof BaseUnavailableError) {
      res.status(503).json({ error: 'base_unavailable', message: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/tasks/:id/branches — list branches in a task's worktree
router.get('/api/tasks/:id/branches', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd || !fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Task has no usable worktree' });
    return;
  }
  try {
    const result = await listBranches(cwd);
    res.json(result);
  } catch (err) {
    logger.warn({ task_id: task.id, err: (err as Error).message }, 'listBranches failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/tasks/:id/commits — list commits in a task's worktree
router.get('/api/tasks/:id/commits', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd || !fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Task has no usable worktree' });
    return;
  }

  // Determine the from/to refs. If `range=` is provided, derive from it; else
  // default to base..HEAD when we have a base_sha, or just HEAD when we don't.
  let from: string | undefined;
  let to = 'HEAD';
  const rangeParam = typeof req.query.range === 'string' ? req.query.range : undefined;
  if (rangeParam) {
    try {
      const parsed = parseDiffRange(rangeParam);
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
          // No commits in a working-only range.
          res.json({ commits: [], truncated: false });
          return;
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /api/tasks/:id/base — change base branch for a task
router.patch('/api/tasks/:id/base', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  if (task.runtime_state === 'idle') {
    res.status(409).json({ error: 'cannot change base on a draft task' });
    return;
  }
  if (!task.worktree_id) {
    res.status(400).json({ error: 'task has no worktree row to update' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd || !fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Task has no usable worktree' });
    return;
  }

  const baseBranch = (req.body as { base_branch?: unknown }).base_branch;
  if (typeof baseBranch !== 'string' || !baseBranch.trim()) {
    res.status(400).json({ error: 'base_branch is required' });
    return;
  }

  let sha: string;
  try {
    sha = await resolveRef(cwd, baseBranch);
  } catch (err) {
    logger.warn(
      { task_id: task.id, base_branch: baseBranch, err: (err as Error).message },
      'resolveRef failed',
    );
    res.status(400).json({ error: 'ref does not resolve' });
    return;
  }

  // Persist the new base on the joined worktrees row (Phase 2a moved these
  // columns off `tasks`). Bump the task's updated_at separately.
  setWorktreeBase(task.worktree_id, baseBranch, sha);
  touchUpdatedAt(task.id);

  // Invalidate any cached origin tip for old/new branch on this worktree so
  // the next diff fetch resolves fresh.
  if (task.base_branch) clearDiffBaseCache(cwd, task.base_branch);
  clearDiffBaseCache(cwd, baseBranch);

  logger.info({ task_id: task.id, base_branch: baseBranch, base_sha: sha }, 'task base changed');

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });

  const reloaded = getTaskRepo(task.id);
  res.json(reloaded);
});
