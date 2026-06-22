import express from 'express';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import { childLogger } from '../logger.js';
import { getNeedsYou, getActivity } from '../inbox.js';
import { startTask, closeTask, softDeleteTask, deleteTask, resumeTask } from '../task-runner.js';
import { broadcast } from '../events.js';
import { generateTitleAndDescription } from '../title-gen.js';
import { ensureHookToken } from '../hook-token.js';
import { validateAgentName } from '../harnesses/types.js';
import { getHarness } from '../harnesses/index.js';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  Task,
  Agent,
  UserTerminal,
  RunMode,
  MoveTaskRequest,
  SummaryRequest,
  NoteRequest,
  AddRefRequest,
} from '../types.js';
import { RUN_MODES, WORKFLOW_STATUSES } from '../types.js';
import { fireHook, getTaskHookExecutions } from '../hook-dispatcher.js';
import {
  getTask as getTaskRepo,
  listTasks,
  listDoneTasks,
  updateTaskFields,
  setRuntimeState,
  setWorkflowStatus,
  softDeleteTask as softDeleteTaskRepo,
  restoreTask as restoreTaskRepo,
  hardDeleteTask,
  touchLastViewed,
  touchAllLastViewed,
  setCurrentSummary,
  addTaskUpdate,
  listTaskUpdates,
  getTaskExternalRefs,
  getTaskExternalRef,
  upsertTaskExternalRef,
  deleteTaskExternalRef,
  getWorktree,
  listAllAgents,
  listAgentsByTasks,
  listPendingPromptsByTask,
  listPendingPromptsByTasks,
  listUserTerminals,
  listUserTerminalsByTasks,
  insertWorktree as insertWorktreeRepo,
  updateWorktreeFields,
} from '../repositories/index.js';

import { createTask } from '../services/task-service.js';
import { ServiceError } from '../services/errors.js';
import {
  loadTaskOrFail,
  lookupExistingReviewId,
  fetchTaskBundle,
  derivedStatus,
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

  const promptsByTask = new Map<string, Array<Record<string, unknown>>>();
  for (const pp of allPrompts) {
    const taskId = pp.task_id as string;
    const list = promptsByTask.get(taskId) || [];
    list.push({ ...pp });
    promptsByTask.set(taskId, list);
  }

  const terminalsByTask = new Map<string, UserTerminal[]>();
  for (const ut of allTerminals) {
    const list = terminalsByTask.get(ut.task_id) || [];
    list.push(ut);
    terminalsByTask.set(ut.task_id, list);
  }

  const result = tasks.map((task) => {
    const agents = agentsByTask.get(task.id) || [];
    return {
      ...task,
      agents,
      pending_prompts: promptsByTask.get(task.id) || [],
      derived_status: derivedStatus({ runtime_state: task.runtime_state, agents }),
      user_terminals: terminalsByTask.get(task.id) || [],
    };
  });

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
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  touchLastViewed(task.id);
  apiLogger.info({ task_id: task.id, operation: 'marked_viewed' }, 'marked task viewed');
  const updated = getTaskRepo(task.id) as Task;
  res.json(updated);
});

// Get single task with agents
router.get('/api/tasks/:id', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const rawAgents = listAllAgents(task.id);
  // Backfill hook_token for pre-step-1 agents that have an empty token.
  const agents = await Promise.all(
    rawAgents.map(async (agent) => {
      if (agent.hook_token !== '') return agent;
      const token = await ensureHookToken(agent, task.worktree ?? null);
      return { ...agent, hook_token: token };
    }),
  );
  const pendingPrompts = listPendingPromptsByTask(task.id);
  const parsedPrompts = pendingPrompts;
  const userTerminals = listUserTerminals(task.id);
  const worktreeRow = task.worktree_id ? (getWorktree(task.worktree_id) ?? null) : null;
  res.json({
    ...task,
    agents,
    pending_prompts: parsedPrompts,
    derived_status: derivedStatus({ runtime_state: task.runtime_state, agents }),
    user_terminals: userTerminals,
    worktree_row: worktreeRow,
    existing_review_id: lookupExistingReviewId(task),
  });
});

// Create task
router.post('/api/tasks', async (req: Request, res: Response) => {
  const body = req.body as CreateTaskRequest;
  const runMode: RunMode = body.run_mode ?? 'new';

  if ((!body.title || !body.description) && !body.initial_prompt) {
    res.status(400).json({ error: 'title and description are required' });
    return;
  }
  if (!RUN_MODES.includes(runMode)) {
    res.status(400).json({ error: `invalid run_mode: ${String(runMode)}` });
    return;
  }

  // Per-mode field requirements
  if (runMode === 'new' || runMode === 'none') {
    if (!body.repo_path) {
      res.status(400).json({ error: `repo_path is required for run_mode=${runMode}` });
      return;
    }
  }
  if (runMode === 'existing') {
    if (!body.worktree_path) {
      res.status(400).json({ error: 'worktree_path is required for run_mode=existing' });
      return;
    }
    if (body.base_branch) {
      res.status(400).json({ error: 'base_branch is not allowed for run_mode=existing' });
      return;
    }
  }
  if (runMode === 'none') {
    if (body.branch || body.worktree_path) {
      res.status(400).json({
        error: 'branch and worktree_path are not allowed for run_mode=none',
      });
      return;
    }
    // base_branch is allowed for none mode (triggers branch switch at setup)
  }
  if (runMode === 'scratch') {
    if (body.repo_path || body.base_branch || body.branch || body.worktree_path) {
      res.status(400).json({
        error: 'repo_path, base_branch, branch, worktree_path are not allowed for run_mode=scratch',
      });
      return;
    }
  }

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  if (body.harness_id != null) {
    try {
      getHarness(body.harness_id);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

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

  // Title/description resolution
  //
  // Fast path: fill blanks from initial_prompt locally (never blocks on Claude CLI).
  // Optional polish: OCTOMUX_AI_TASK_NAMING=1 / true restores the old behaviour of
  // calling generateTitleAndDescription for whichever of title/description the client omitted.
  const hadExplicitTitle = Boolean(body.title?.trim());
  const hadExplicitDescription = Boolean(body.description?.trim());
  let resolvedTitle = body.title?.trim();
  let resolvedDescription = body.description?.trim();

  const initialPromptTrimmed = body.initial_prompt?.trim() ?? '';
  if (initialPromptTrimmed) {
    const firstLine = initialPromptTrimmed.split('\n')[0] ?? '';
    if (!resolvedTitle) {
      resolvedTitle = firstLine.slice(0, 80) || 'Untitled task';
    }
    if (!resolvedDescription) {
      resolvedDescription = initialPromptTrimmed;
    }
  }

  const aiNamingEnv = process.env.OCTOMUX_AI_TASK_NAMING ?? '';
  const aiTaskNamingEnabled = aiNamingEnv === '1' || aiNamingEnv.toLowerCase() === 'true';
  if (
    initialPromptTrimmed &&
    aiTaskNamingEnabled &&
    (!hadExplicitTitle || !hadExplicitDescription)
  ) {
    const generated = await generateTitleAndDescription(body.initial_prompt!);
    if (!hadExplicitTitle) resolvedTitle = generated.title;
    if (!hadExplicitDescription) resolvedDescription = generated.description;
  }

  resolvedTitle =
    resolvedTitle ||
    initialPromptTrimmed.split('\n')[0]?.slice(0, 80) ||
    body.initial_prompt?.split('\n')[0]?.slice(0, 80) ||
    'Untitled task';
  resolvedDescription = resolvedDescription || body.initial_prompt || '';

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

  try {
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
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.message });
    } else {
      throw err;
    }
  }
});

// Update task status
router.patch('/api/tasks/:id', async (req: Request, res: Response) => {
  const body = req.body as UpdateTaskRequest;
  const task = loadTaskOrFail(req, res);
  if (!task) return;

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
    const isDraft = task.runtime_state === 'idle';
    if (!isDraft) {
      res.status(400).json({ error: 'Can only edit fields on draft tasks' });
      return;
    }
    if (body.title !== undefined && !body.title.trim()) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    if (body.description !== undefined && !body.description.trim()) {
      res.status(400).json({ error: 'description is required' });
      return;
    }
    if (body.repo_path !== undefined) {
      if (!body.repo_path.trim()) {
        res.status(400).json({ error: 'repo_path is required' });
        return;
      }
      if (!fs.existsSync(body.repo_path)) {
        res.status(400).json({ error: 'repo_path does not exist' });
        return;
      }
    }

    if (body.run_mode !== undefined && !RUN_MODES.includes(body.run_mode)) {
      res.status(400).json({ error: `invalid run_mode: ${String(body.run_mode)}` });
      return;
    }

    // Route updates between tasks (title/description/initial_prompt) and
    // worktrees (repo_path/branch/base_branch/path/mode).
    const taskPatch: Partial<Record<string, unknown>> = {};
    for (const key of ['title', 'description', 'initial_prompt'] as const) {
      if (body[key] !== undefined) {
        taskPatch[key] = body[key] ?? null;
      }
    }
    if (Object.keys(taskPatch).length > 0) {
      updateTaskFields(task.id, taskPatch);
    }

    const worktreePatch: Partial<Record<string, unknown>> = {};
    if (body.repo_path !== undefined) worktreePatch['repo_path'] = body.repo_path ?? null;
    if (body.branch !== undefined) worktreePatch['branch'] = body.branch ?? null;
    if (body.base_branch !== undefined) worktreePatch['base_branch'] = body.base_branch ?? null;
    if (body.worktree_path !== undefined) worktreePatch['path'] = body.worktree_path ?? '';
    if (body.run_mode !== undefined) worktreePatch['mode'] = body.run_mode;

    if (Object.keys(worktreePatch).length > 0) {
      let wtId = task.worktree_id;
      if (!wtId) {
        // Materialise a placeholder worktree row for this draft; fields get
        // refined as the user edits or at setup time.
        wtId = nanoid(12);
        insertWorktreeRepo({
          id: wtId,
          path: '',
          mode: body.run_mode ?? task.run_mode ?? 'new',
          status: 'available',
        });
        updateTaskFields(task.id, { worktree_id: wtId });
      }
      updateWorktreeFields(wtId, worktreePatch);
    }
  } else if (body.status === 'running' || body.runtime_state === 'running') {
    // Resume task
    if (task.runtime_state !== 'idle' && task.runtime_state !== 'error') {
      res.status(400).json({ error: 'Can only resume tasks in closed or error state' });
      return;
    }
    if (task.run_mode === 'new' || task.run_mode === 'existing' || task.run_mode === 'scratch') {
      if (!task.worktree || !fs.existsSync(task.worktree)) {
        res.status(400).json({ error: 'Worktree no longer exists on disk' });
        return;
      }
    } else if (task.run_mode === 'none') {
      if (!fs.existsSync(task.repo_path)) {
        res.status(400).json({ error: 'repo_path no longer exists on disk' });
        return;
      }
    }
    await resumeTask(task);
  } else if (body.status === 'closed' || body.runtime_state === 'idle') {
    await closeTask(task);
  } else if (body.workflow_status) {
    // Direct workflow_status flip (simpler version without note/transition tracking)
    if (!WORKFLOW_STATUSES.includes(body.workflow_status)) {
      res.status(400).json({ error: `invalid workflow_status: ${body.workflow_status}` });
      return;
    }
    setWorkflowStatus(task.id, body.workflow_status);
  }

  const updated = fetchTaskBundle(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(updated);
});

// Start a draft task
router.post('/api/tasks/:id/start', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.runtime_state !== 'idle') {
    res.status(400).json({ error: 'Only draft tasks can be started' });
    return;
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
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (req.query.purge === 'true') {
    if (task.deleted_at == null) {
      res.status(409).json({ error: 'task must be soft-deleted before purge' });
      return;
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
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  if (task.deleted_at == null) {
    res.status(409).json({ error: 'task is not in trash' });
    return;
  }

  restoreTaskRepo(task.id);
  const refreshed = getTaskRepo(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  res.json(refreshed);
});

// Move task to a new workflow_status
router.post('/api/tasks/:id/move', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as MoveTaskRequest;

  if (!body.workflow_status || !WORKFLOW_STATUSES.includes(body.workflow_status)) {
    res.status(400).json({ error: `invalid workflow_status: ${body.workflow_status}` });
    return;
  }
  if (
    (body.workflow_status === 'human_review' || body.workflow_status === 'planned') &&
    !body.note?.trim()
  ) {
    res.status(400).json({ error: `note is required when moving to ${body.workflow_status}` });
    return;
  }

  // Auto-close runtime when moving to the terminal column (done) if
  // the task is still actively running. Keeps the worktree/branch (close, not delete).
  if (
    body.workflow_status === 'done' &&
    (task.runtime_state === 'running' || task.runtime_state === 'setting_up')
  ) {
    await closeTask(task);
  }

  const prevStatus = task.workflow_status;
  setWorkflowStatus(task.id, body.workflow_status);

  addTaskUpdate({
    task_id: task.id,
    kind: 'transition',
    from_status: prevStatus,
    to_status: body.workflow_status,
    body: body.note ?? null,
  });

  // Auto-start: moving to in_progress should kick the task into setting_up
  // if it isn't already running. Mirrors POST /api/tasks/:id/start and the
  // resume branch of PATCH /api/tasks/:id, but triggered by a board move.
  let autoStart: 'start' | 'resume' | null = null;
  if (
    body.workflow_status === 'in_progress' &&
    (task.runtime_state === 'idle' || task.runtime_state === 'error')
  ) {
    autoStart = task.worktree ? 'resume' : 'start';
  }
  if (autoStart) {
    setRuntimeState(task.id, 'setting_up', null);
  }

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  fireHook('workflow_status_changed', {
    event: 'workflow_status_changed',
    task: {
      ...task,
      workflow_status: body.workflow_status as import('../types.js').WorkflowStatus,
    },
    data: { from: prevStatus, to: body.workflow_status, note: body.note },
  });

  const updated = fetchTaskBundle(task.id);
  res.json(updated);

  // Fire-and-forget after responding so the client gets the optimistic
  // setting_up state immediately and a follow-up task:updated broadcast
  // surfaces success or error.
  if (autoStart === 'start') {
    startTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  } else if (autoStart === 'resume') {
    resumeTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  }
});

// Post a summary for a task
router.post('/api/tasks/:id/summary', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as SummaryRequest;

  if (!body.summary?.trim()) {
    res.status(400).json({ error: 'summary is required' });
    return;
  }

  setCurrentSummary(task.id, body.summary);
  addTaskUpdate({ task_id: task.id, kind: 'summary', body: body.summary });

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  fireHook('summary_updated', {
    event: 'summary_updated',
    task: { ...task, current_summary: body.summary },
    data: { summary: body.summary },
  });

  const updated = fetchTaskBundle(task.id);
  res.json(updated);
});

// Add a note to a task
router.post('/api/tasks/:id/note', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as NoteRequest;

  if (!body.body?.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }

  const updateId = addTaskUpdate({ task_id: task.id, kind: 'note', body: body.body });

  fireHook('note_added', {
    event: 'note_added',
    task,
    data: { body: body.body },
  });

  res.status(201).json({ id: updateId, task_id: task.id, kind: 'note', body: body.body });
});

// Add/replace an external ref
router.post('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const body = req.body as AddRefRequest & { metadata?: unknown };

  if (!body.integration?.trim()) {
    res.status(400).json({ error: 'integration is required' });
    return;
  }
  if (!body.ref?.trim()) {
    res.status(400).json({ error: 'ref is required' });
    return;
  }
  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
  ) {
    res.status(400).json({ error: 'metadata must be a JSON object' });
    return;
  }

  const result = upsertTaskExternalRef({
    task_id: task.id,
    integration: body.integration,
    ref: body.ref,
    url: body.url ?? null,
    metadata:
      body.metadata !== null &&
      body.metadata !== undefined &&
      typeof body.metadata === 'object' &&
      !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : null,
  });

  fireHook('ref_added', {
    event: 'ref_added',
    task,
    data: { integration: body.integration, ref: body.ref, url: body.url },
  });

  res.status(201).json(result);
});

// Delete an external ref
router.delete('/api/tasks/:id/refs/:integration', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const integration = (req.params as Record<string, string>).integration;

  const existing = getTaskExternalRef(task.id, integration);
  if (!existing) {
    res.status(404).json({ error: 'Ref not found' });
    return;
  }

  deleteTaskExternalRef(task.id, integration);

  fireHook('ref_removed', {
    event: 'ref_removed',
    task,
    data: { integration },
  });

  res.status(204).send();
});

// Get task updates (timeline)
router.get('/api/tasks/:id/updates', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

  const updates = listTaskUpdates(task.id, limit);
  res.json(updates);
});

// Get task external refs
router.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  res.json(getTaskExternalRefs(task.id));
});

// ─── Hook executions for a task ──────────────────────────────────────────────
router.get('/api/tasks/:id/hooks', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
  const executions = getTaskHookExecutions(task.id, limit);
  res.json(executions);
});
