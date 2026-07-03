import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { childLogger } from '../logger.js';
import { getNeedsYou, getActivity } from '../inbox.js';
import {
  startTask,
  closeTask,
  softDeleteTask,
  deleteTask,
  resumeTask,
} from '../task-engine/index.js';
import { broadcast } from '../events.js';
import { ensureHookToken } from '../hook-token.js';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  Task,
  Agent,
  UserTerminal,
  RunMode,
} from '../types.js';
import { WORKFLOW_STATUSES } from '../types.js';
import {
  getTask as getTaskRepo,
  listTasks,
  listDoneTasks,
  setRuntimeState,
  setWorkflowStatus,
  softDeleteTask as softDeleteTaskRepo,
  restoreTask as restoreTaskRepo,
  hardDeleteTask,
  touchLastViewed,
  touchAllLastViewed,
  getWorktree,
  listAgentsByTasks,
  listPendingPromptsByTasks,
  listUserTerminalsByTasks,
} from '../repositories/index.js';
import type { PermissionPromptRow } from '../repositories/permission-prompts.js';

import { createTask } from '../services/task-service.js';
import { badRequest, conflict } from '../services/errors.js';
import {
  loadTaskOrFail,
  lookupExistingReviewId,
  fetchTaskBundle,
  fetchTaskWithRelations,
  formatTaskResponse,
  validateCreateTaskBody,
  applyDraftUpdates,
  resolveTaskTitleAndDescription,
  throwIfValidationError,
} from './_shared.js';

const apiLogger = childLogger('api');

export const router = express.Router();

// List all tasks with agents
router.get('/api/tasks', (req: Request, res: Response) => {
  const repoPath = req.query.repo_path as string | undefined;
  const trash = req.query.trash === 'true';

  const tasks = listTasks({ trash, repoPath, includeAutoReview: false });

  if (tasks.length === 0) {
    res.json([]);
    return;
  }

  // Bulk-fetch all related data for the matching tasks
  const taskIds = tasks.map((t) => t.id);

  const allAgents = listAgentsByTasks(taskIds);
  const allPrompts = listPendingPromptsByTasks(taskIds);
  const allTerminals = listUserTerminalsByTasks(taskIds);

  // Group by task_id using Maps
  const agentsByTask = new Map<string, Agent[]>();
  for (const agent of allAgents) {
    if (!agent.task_id) continue; // standalone agents don't belong to a task
    const list = agentsByTask.get(agent.task_id) || [];
    list.push(agent);
    agentsByTask.set(agent.task_id, list);
  }

  const promptsByTask = new Map<string, PermissionPromptRow[]>();
  for (const pp of allPrompts) {
    const taskId = pp.task_id as string;
    const list = promptsByTask.get(taskId) || [];
    list.push(pp);
    promptsByTask.set(taskId, list);
  }

  const terminalsByTask = new Map<string, UserTerminal[]>();
  for (const ut of allTerminals) {
    const list = terminalsByTask.get(ut.task_id) || [];
    list.push(ut);
    terminalsByTask.set(ut.task_id, list);
  }

  const result = tasks.map((task) =>
    formatTaskResponse(task, {
      agents: agentsByTask.get(task.id) || [],
      pending_prompts: promptsByTask.get(task.id) || [],
      user_terminals: terminalsByTask.get(task.id) || [],
    }),
  );

  res.json(result);
});

// Inbox: tasks needing attention + recent activity
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
    // Close running tasks before soft-deleting
    if (task.runtime_state === 'running' || task.runtime_state === 'setting_up') {
      await closeTask(task);
    }

    softDeleteTaskRepo(task.id);

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
router.get('/api/tasks/:id', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const { relations } = fetchTaskWithRelations(task.id);
  // Backfill hook_token for pre-step-1 agents that have an empty token.
  const agents = await Promise.all(
    relations.agents.map(async (agent) => {
      if (agent.hook_token !== '') return agent;
      const token = await ensureHookToken(agent, task.worktree ?? null);
      return { ...agent, hook_token: token };
    }),
  );
  const worktreeRow = task.worktree_id ? (getWorktree(task.worktree_id) ?? null) : null;
  res.json(
    formatTaskResponse(
      task,
      { ...relations, agents },
      {
        worktree_row: worktreeRow,
        existing_review_id: lookupExistingReviewId(task),
      },
    ),
  );
});

// Create task
router.post('/api/tasks', async (req: Request, res: Response) => {
  const body = req.body as CreateTaskRequest;
  const runMode: RunMode = body.run_mode ?? 'new';

  throwIfValidationError(validateCreateTaskBody(body, runMode));

  // Derive stored repo_path / worktree
  let storedRepoPath: string;
  let storedWorktree: string | null;
  if (runMode === 'scratch') {
    storedRepoPath = '';
    storedWorktree = null;
  } else if (runMode === 'existing') {
    storedRepoPath = body.repo_path ?? '';
    storedWorktree = body.worktree_path!;
  } else {
    storedRepoPath = body.repo_path!;
    storedWorktree = null;
  }

  // Title/description resolution (fast path + optional AI polish via OCTOMUX_AI_TASK_NAMING)
  const { resolvedTitle, resolvedDescription } = await resolveTaskTitleAndDescription(body);

  const isDraft = !!body.draft;

  // Phase 2a: worktrees owns path/branch/base/repo. Always create a
  // worktree row at task creation. For `new` mode the path isn't known
  // until setup runs (derived from slug); stage it as empty string and
  // task-runner updates it when the git worktree is cut.
  const stagedPath =
    runMode === 'existing' ? storedWorktree! : runMode === 'none' ? storedRepoPath : '';

  // Determine workflow_status at creation time.
  let initialWorkflowStatus: string;
  if (body.workflow_status) {
    initialWorkflowStatus = body.workflow_status;
  } else if (isDraft && !body.initial_prompt) {
    initialWorkflowStatus = 'backlog';
  } else if (isDraft && body.initial_prompt) {
    initialWorkflowStatus = 'planned';
  } else {
    // starting immediately — will be flipped to in_progress once running
    initialWorkflowStatus = 'planned';
  }

  const created = await createTask({
    resolved_title: resolvedTitle!,
    resolved_description: resolvedDescription!,
    initial_prompt: body.initial_prompt ?? null,
    run_mode: runMode,
    stored_repo_path: storedRepoPath,
    staged_path: stagedPath,
    branch: body.branch ?? null,
    base_branch: body.base_branch ?? null,
    worktree_status: 'available',
    runtime_state: isDraft ? 'idle' : 'setting_up',
    workflow_status: initialWorkflowStatus,
    agent: body.agent ?? null,
    harness_id: body.harness_id ?? 'claude-code',
    model: body.model ?? null,
    notify_task_id: body.notify_task_id ?? null,
    is_draft: isDraft,
  });
  res.status(201).json(created);
});

// Update task status
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
  } else if (body.status === 'running' || body.runtime_state === 'running') {
    // Resume task
    if (task.runtime_state !== 'idle' && task.runtime_state !== 'error') {
      throw badRequest('Can only resume tasks in closed or error state');
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
  } else if (body.status === 'closed' || body.runtime_state === 'idle') {
    await closeTask(task);
  } else if (body.workflow_status) {
    // Direct workflow_status flip (simpler version without note/transition tracking)
    if (!WORKFLOW_STATUSES.includes(body.workflow_status)) {
      throw badRequest(`invalid workflow_status: ${body.workflow_status}`);
    }
    setWorkflowStatus(task.id, body.workflow_status);
  }

  const updated = fetchTaskBundle(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(updated);
});

// Start a draft task
router.post('/api/tasks/:id/start', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (task.runtime_state !== 'idle') {
    throw badRequest('Only draft tasks can be started');
  }

  // Set status immediately so client sees setting_up
  setRuntimeState(task.id, 'setting_up');

  const updated = fetchTaskBundle(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(updated);

  // Fire-and-forget
  startTask(task)
    .then(() => {
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    })
    .catch(() => {
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    });
});

// Delete task (soft by default; ?purge=true hard-deletes a previously soft-deleted task)
router.delete('/api/tasks/:id', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  if (req.query.purge === 'true') {
    if (task.deleted_at == null) {
      throw conflict('task must be soft-deleted before purge');
    }
    const taskId = task.id;
    await deleteTask(task);
    // ON DELETE CASCADE removes agents, permission_prompts, user_terminals
    hardDeleteTask(taskId);
    broadcast({ type: 'task:deleted', payload: { taskId } });
  } else {
    await softDeleteTask(task);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  }

  res.status(204).send();
});

// Restore a soft-deleted task
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
