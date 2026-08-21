import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { childLogger } from '../logger.js';
import { getNeedsYou, getActivity } from '../inbox.js';
import { closeTask, softDeleteTask, resumeTask } from '../task-engine/index.js';
import { broadcast } from '../events.js';
import type { UpdateTaskRequest, Task } from '../types.js';
import {
  getTask as getTaskRepo,
  listDoneTasks,
  restoreTask as restoreTaskRepo,
  touchLastViewed,
  touchAllLastViewed,
  isDependencyUnmet,
} from '../repositories/index.js';

import { badRequest, conflict } from '../services/errors.js';
import {
  loadTaskOrFail,
  fetchTaskBundle,
  applyDraftUpdates,
  throwIfValidationError,
} from './_shared.js';

const apiLogger = childLogger('api');

export const router = express.Router();

// List all tasks with agents
router.get('/api/tasks/inbox', (_req: Request, res: Response) => {
  res.json({ needs_you: getNeedsYou(), activity: getActivity() });
});

// Mark all tasks viewed
router.post('/api/tasks/viewed-all', (_req: Request, res: Response) => {
  const updated = touchAllLastViewed();
  apiLogger.info({ operation: 'marked_all_viewed', updated }, 'marked all tasks viewed');
  res.json({ updated });
});

// B3: Bulk-delete all done tasks (soft-delete)
// IMPORTANT: registered before /:id so it does not match as an :id param
router.post('/api/tasks/delete-done', async (req: Request, res: Response) => {
  const doneTasks = listDoneTasks();

  let deletedCount = 0;
  for (const task of doneTasks) {
    // task-engine softDeleteTask kills the tmux session (and its agent
    // processes) before soft-deleting — same as single-task delete
    await softDeleteTask(task);

    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    deletedCount++;
  }

  apiLogger.info({ operation: 'delete_done', deleted: deletedCount }, 'bulk delete done');
  res.json({ deleted: deletedCount });
});

// Mark a single task viewed
router.patch('/api/tasks/:id/viewed', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  touchLastViewed(task.id);
  apiLogger.info({ task_id: task.id, operation: 'marked_viewed' }, 'marked task viewed');
  const updated = getTaskRepo(task.id) as Task;
  res.json(updated);
});

// Get single task with agents
router.patch('/api/tasks/:id', async (req: Request, res: Response) => {
  const body = req.body as UpdateTaskRequest;
  const task = loadTaskOrFail(req);

  // Draft field updates
  const hasDraftFields = [
    'title',
    'description',
    'repo_path',
    'branch',
    'base_branch',
    'initial_prompt',
    'run_mode',
    'worktree_path',
  ].some((k) => (body as Record<string, unknown>)[k] !== undefined);

  if (hasDraftFields) {
    throwIfValidationError(applyDraftUpdates(task, body));
  } else if (body.runtime_state === 'running') {
    // Resume task
    if (task.runtime_state !== 'idle' && task.runtime_state !== 'error') {
      throw badRequest('Can only resume tasks in closed or error state');
    }
    if (isDependencyUnmet(task.depends_on)) {
      throw badRequest(
        `cannot resume: waiting on depends_on task ${task.depends_on} to reach 'done'`,
      );
    }
    if (task.run_mode === 'new' || task.run_mode === 'existing' || task.run_mode === 'scratch') {
      if (!task.worktree || !fs.existsSync(task.worktree)) {
        throw badRequest('Worktree no longer exists on disk');
      }
    } else if (task.run_mode === 'none') {
      if (!fs.existsSync(task.repo_path)) {
        throw badRequest('repo_path no longer exists on disk');
      }
    }
    await resumeTask(task);
  } else if (body.runtime_state === 'idle') {
    // Check BEFORE calling closeTask so a 409 here is honest about having
    // changed nothing — an already-idle task has no tmux session to kill.
    if (task.runtime_state === 'idle') {
      throw conflict('task is already closed (runtime_state=idle) — nothing to close');
    }
    await closeTask(task);
  } else if (body.workflow_status) {
    // One implementation of "change a task's status", not two. This used to do
    // a bare setWorkflowStatus, skipping the note requirement, the task_updates
    // transition row, the workflow_status_changed webhook and the auto-start —
    // all of which the task.move capability does. A second, quieter path to the
    // same field is how the two drift apart.
    throw badRequest(
      'workflow_status cannot be set via PATCH — use POST /api/tasks/:id/move, ' +
        'which records the transition and fires workflow_status_changed',
    );
  } else {
    // SHR-278: a stale/wrong client body (e.g. the pre-rename `{ status: 'closed' }`)
    // used to fall through every branch above and hit fetchTaskBundle unchanged,
    // returning 200 with nothing done — four tasks silently failed to close and
    // nobody could tell from the response. Reject instead of pretending success.
    const gotKeys = Object.keys(body ?? {});
    throw badRequest(
      `PATCH body had no actionable field (got: ${gotKeys.length ? gotKeys.join(', ') : 'none'}). ` +
        'Expected one of: runtime_state, title, description, repo_path, branch, base_branch, ' +
        'initial_prompt, run_mode, worktree_path. To change workflow_status use POST /api/tasks/:id/move.',
    );
  }

  const updated = fetchTaskBundle(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(updated);
});

// Start a draft task
router.post('/api/tasks/:id/restore', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.deleted_at == null) {
    throw conflict('task is not in trash');
  }

  restoreTaskRepo(task.id);
  const refreshed = getTaskRepo(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(refreshed);
});
