import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from '../logger.js';
import {
  getWorktree,
  listWorktrees as listWorktreesRepo,
  listTasksByWorktree,
  listTasksForWorktree,
  deleteWorktree as deleteWorktreeRepo,
  unlinkWorktreeFromAllTasks,
} from '../repositories/index.js';

const execFile = promisify(execFileCb);
const apiLogger = childLogger('api');

export const router = express.Router();

// ─── Worktrees (browser) ─────────────────────────────────────────────────

router.get('/api/worktrees', (_req: Request, res: Response) => {
  // The worktrees table holds one row per task lifecycle, but the same
  // physical workspace (same repo_path / mode / branch / path) may back
  // many tasks over time — most visibly in `none` mode where every task
  // points at the same repo checkout. Collapse those into a single row,
  // pick the freshest member as the row id (so detail navigation lands on
  // the active task), and aggregate task counts and recency. Rows that no
  // task references are leftover state and stay hidden — the workspaces
  // list mirrors actual user activity, not historical bookkeeping.
  res.json(listWorktreesRepo());
});

router.get('/api/worktrees/:id', (req: Request, res: Response) => {
  const worktree = getWorktree(req.params.id as string);
  if (!worktree) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }
  const tasks = listTasksByWorktree(worktree.id);
  const active = tasks.find((t) => {
    return (['setting_up', 'running'] as const).includes(t.runtime_state as 'running');
  });
  const history = tasks.filter((t) => t.id !== active?.id);
  res.json({
    worktree,
    active_task: active ?? null,
    history,
  });
});

router.delete('/api/worktrees/:id', async (req: Request, res: Response) => {
  const worktree = getWorktree(req.params.id as string);
  if (!worktree) {
    res.status(404).json({ error: 'Worktree not found' });
    return;
  }
  if (worktree.status !== 'available') {
    res.status(409).json({ error: 'Worktree is in use' });
    return;
  }
  const referencingTasks = listTasksForWorktree(worktree.id);
  const activeRef = referencingTasks.find((t) =>
    (['setting_up', 'running'] as const).includes(t.runtime_state as 'running'),
  );
  if (activeRef) {
    res.status(409).json({ error: 'Worktree has an active task' });
    return;
  }

  // Only delete filesystem for worktree-owned modes (new/scratch).
  if (worktree.mode === 'new' || worktree.mode === 'scratch') {
    if (worktree.path) {
      try {
        if (worktree.mode === 'new' && worktree.repo_path) {
          await execFile('git', [
            '-C',
            worktree.repo_path,
            'worktree',
            'remove',
            worktree.path,
            '--force',
          ]).catch(() => {});
          if (worktree.branch) {
            await execFile('git', [
              '-C',
              worktree.repo_path,
              'branch',
              '-D',
              worktree.branch,
            ]).catch(() => {});
          }
        }
        if (fs.existsSync(worktree.path)) {
          fs.rmSync(worktree.path, { recursive: true, force: true });
        }
      } catch (err) {
        apiLogger.warn(
          { worktree_id: worktree.id, err, operation: 'delete_worktree' },
          'filesystem cleanup failed',
        );
      }
    }
  }

  // Unlink referencing (terminal-state) tasks before deleting the row.
  unlinkWorktreeFromAllTasks(worktree.id);
  deleteWorktreeRepo(worktree.id);
  apiLogger.info(
    { worktree_id: worktree.id, mode: worktree.mode, operation: 'delete_worktree' },
    'worktree deleted',
  );
  res.status(204).send();
});
