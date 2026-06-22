import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from './logger.js';
import { getNeedsYou, getActivity } from './inbox.js';
import {
  startTask,
  closeTask,
  softDeleteTask,
  deleteTask,
  resumeTask,
  addAgent,
  stopAgent,
  createUserTerminal,
  createShellTerminal,
  closeShellTerminal,
} from './task-runner.js';
import { sendMessageToAgent } from './tmux-input.js';
import { seedInlineComment } from './repositories/inline-comments.js';
import { seedReviewRun } from './repositories/review-runs.js';
import { mountArtifactEndpoint } from './orchestrator/artifact-endpoint.js';

import { validateAgentName } from './harnesses/types.js';
import { getHarness } from './harnesses/index.js';
import { hookRoutes } from './hooks.js';
import { broadcast } from './events.js';
import { generateTitleAndDescription } from './title-gen.js';
import { ensureHookToken } from './hook-token.js';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Task,
  Agent,
  UserTerminal,
  RunMode,
  MoveTaskRequest,
  SummaryRequest,
  NoteRequest,
  AddRefRequest,
} from './types.js';
import { RUN_MODES, WORKFLOW_STATUSES } from './types.js';
import { fireHook, getTaskHookExecutions } from './hook-dispatcher.js';
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
  listWorktrees as listWorktreesRepo,
  listTasksByWorktree,
  listTasksForWorktree,
  deleteWorktree as deleteWorktreeRepo,
  unlinkWorktreeFromAllTasks,
  insertWorktree as insertWorktreeRepo,
  updateWorktreeFields,
  getAgentByIdAndTask,
  listAllAgents,
  listAgentsByTasks,
  listPendingPromptsByTask,
  listPendingPromptsByTasks,
  listUserTerminals,
  listUserTerminalsByTasks,
  getUserTerminalByIdAndTask,
  insertWorktreeIfAbsent,
  insertTaskIfAbsent,
  inTransaction,
} from './repositories/index.js';

import { createTask } from './services/task-service.js';
import { ServiceError } from './services/errors.js';

import { router as miscRouter } from './routes/misc.js';
import { router as learningsRouter } from './routes/learnings.js';
import { router as skillsRouter } from './routes/skills.js';
import { router as teamsRouter } from './routes/teams.js';
import { router as setupRouter } from './routes/setup.js';
import { router as settingsRouter } from './routes/settings.js';
import { router as hooksRegistryRouter } from './routes/hooks-registry.js';
import { router as chatsRouter } from './routes/chats.js';
import { router as agentDefsRouter } from './routes/agent-defs.js';
import { router as orchestratorRouter } from './routes/orchestrator.js';
import { router as integrationsRouter } from './routes/integrations.js';
import { router as reviewsRouter } from './routes/reviews.js';
import { router as reviewRunsRouter } from './routes/review-runs.js';
import { router as commentsRouter } from './routes/comments.js';
import { router as diffsRouter } from './routes/diffs.js';

import {
  loadTaskOrFail,
  lookupExistingReviewId,
  fetchTaskBundle,
  derivedStatus,
} from './routes/_shared.js';

const execFile = promisify(execFileCb);
const apiLogger = childLogger('api');

export function setupRoutes(app: Express): void {
  app.use('/api/hooks', hookRoutes);
  mountArtifactEndpoint(app);

  // Mount extracted routers (bare app.use — each router keeps full /api/... paths)
  app.use(miscRouter);
  app.use(learningsRouter);
  app.use(skillsRouter);
  app.use(teamsRouter);
  app.use(setupRouter);
  app.use(settingsRouter);
  app.use(hooksRegistryRouter);
  app.use(chatsRouter);
  app.use(agentDefsRouter);
  app.use(orchestratorRouter);
  app.use(integrationsRouter);
  app.use(reviewsRouter);
  app.use(reviewRunsRouter);
  app.use(commentsRouter);
  app.use(diffsRouter);

  // List all tasks with agents
  app.get('/api/tasks', (req: Request, res: Response) => {
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
  app.get('/api/tasks/inbox', (_req: Request, res: Response) => {
    res.json({ needs_you: getNeedsYou(), activity: getActivity() });
  });

  // Mark all tasks viewed
  app.post('/api/tasks/viewed-all', (_req: Request, res: Response) => {
    const updated = touchAllLastViewed();
    apiLogger.info({ operation: 'marked_all_viewed', updated }, 'marked all tasks viewed');
    res.json({ updated });
  });

  // Mark a single task viewed
  app.patch('/api/tasks/:id/viewed', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    touchLastViewed(task.id);
    apiLogger.info({ task_id: task.id, operation: 'marked_viewed' }, 'marked task viewed');
    const updated = getTaskRepo(task.id) as Task;
    res.json(updated);
  });

  // Get single task with agents
  app.get('/api/tasks/:id', async (req: Request, res: Response) => {
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
  app.post('/api/tasks', async (req: Request, res: Response) => {
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
          error:
            'repo_path, base_branch, branch, worktree_path are not allowed for run_mode=scratch',
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
  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
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
  app.post('/api/tasks/:id/start', async (req: Request, res: Response) => {
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
  app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
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
  app.post('/api/tasks/:id/restore', (req: Request, res: Response) => {
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

  // Add agent to task
  app.post('/api/tasks/:id/agents', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    if (task.runtime_state !== 'running') {
      res.status(400).json({ error: 'Can only add agents to running tasks' });
      return;
    }

    const body = req.body as AddAgentRequest;

    if (body.agent != null) {
      try {
        validateAgentName(body.agent);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }

    const agent = await addAgent(task, {
      prompt: body.prompt,
      agent: body.agent,
      label: body.label,
      model: body.model,
      skeleton: body.skeleton,
      notify_agent_id: body.notify_agent_id,
    });
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(201).json(agent);
  });

  // Stop agent
  app.delete('/api/tasks/:id/agents/:agentId', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

    if (!agent) {
      res.status(404).json({ error: 'Task or agent not found' });
      return;
    }

    await stopAgent(task, agent);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json({ success: true });
  });

  // Create user terminal (lazily creates tmux window with nvim)
  app.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    if (task.runtime_state !== 'running') {
      res.status(400).json({ error: 'Can only create user terminal for running tasks' });
      return;
    }

    if (!task.tmux_session) {
      res.status(400).json({ error: 'Task has no tmux session' });
      return;
    }

    try {
      const result = await createUserTerminal(task);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create shell terminal
  app.post('/api/tasks/:id/terminals', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    if (task.runtime_state !== 'running') {
      res.status(400).json({ error: 'Can only create terminals for running tasks' });
      return;
    }
    if (!task.tmux_session) {
      res.status(400).json({ error: 'Task has no tmux session' });
      return;
    }

    try {
      const terminal = await createShellTerminal(task);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      res.status(201).json(terminal);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Close shell terminal
  app.delete('/api/tasks/:id/terminals/:terminalId', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const terminal = getUserTerminalByIdAndTask(
      req.params.terminalId as string,
      req.params.id as string,
    );

    if (!terminal) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    try {
      await closeShellTerminal(task, terminal);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Send message to agent via tmux send-keys
  app.post('/api/tasks/:id/agents/:agentId/message', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    if (task.runtime_state !== 'running') {
      res.status(400).json({ error: 'Task is not running' });
      return;
    }

    const agent = getAgentByIdAndTask(req.params.agentId as string, req.params.id as string);

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { message } = req.body as { message?: string };
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    await sendMessageToAgent(task.tmux_session!, agent.window_index, message);

    res.json({ success: true });
  });

  // ─── Worktrees (browser) ─────────────────────────────────────────────────

  app.get('/api/worktrees', (_req: Request, res: Response) => {
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

  app.get('/api/worktrees/:id', (req: Request, res: Response) => {
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

  app.delete('/api/worktrees/:id', async (req: Request, res: Response) => {
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

  // ─── Task Workflow Endpoints ──────────────────────────────────────────────────

  // B3: Bulk-delete all done tasks (soft-delete)
  app.post('/api/tasks/delete-done', async (req: Request, res: Response) => {
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

  // Move task to a new workflow_status
  app.post('/api/tasks/:id/move', async (req: Request, res: Response) => {
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
        workflow_status: body.workflow_status as import('./types.js').WorkflowStatus,
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
  app.post('/api/tasks/:id/summary', (req: Request, res: Response) => {
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
  app.post('/api/tasks/:id/note', (req: Request, res: Response) => {
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
  app.post('/api/tasks/:id/refs', (req: Request, res: Response) => {
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
  app.delete('/api/tasks/:id/refs/:integration', (req: Request, res: Response) => {
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
  app.get('/api/tasks/:id/updates', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

    const updates = listTaskUpdates(task.id, limit);
    res.json(updates);
  });

  // Get task external refs
  app.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    res.json(getTaskExternalRefs(task.id));
  });

  // ─── Hook executions for a task ──────────────────────────────────────────────
  app.get('/api/tasks/:id/hooks', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const executions = getTaskHookExecutions(task.id, limit);
    res.json(executions);
  });

  // ─── Test-only seed endpoint ─────────────────────────────────────────────────
  // Gated strictly on NODE_ENV=test. Never exposed in production.
  if (process.env.NODE_ENV === 'test') {
    /**
     * POST /api/__test__/seed-review
     * Seeds a review task, a review run, and inline comments directly in the DB.
     *
     * The worktrees row uses:
     *  - `path`      = process.cwd()      — so `git show <sha>:<file>` resolves
     *  - `repo_path` = '/tmp/e2e-norepo'  — so deleteTask's `git worktree remove`
     *                                        fails gracefully on a non-existent repo
     *
     * This ensures staleness checks work with real SHAs/files while preventing
     * deleteTask from accidentally removing the server's working directory.
     */
    app.post('/api/__test__/seed-review', (req: Request, res: Response) => {
      try {
        const body = req.body as {
          task: {
            id: string;
            title: string;
            pr_url: string;
            pr_number: number;
            pr_head_sha: string;
          };
          review_run: {
            id: string;
            walkthrough: string;
          };
          comments: Array<{
            id: string;
            file_path: string;
            line: number;
            side: 'old' | 'new';
            body: string;
            kind: 'comment' | 'suggestion';
            severity?: string;
            bucket?: string;
            existing_code?: string | null;
            suggested_code?: string | null;
          }>;
        };

        inTransaction(() => {
          const wtId = `wt-${body.task.id}`;
          // `path` = server's cwd so git-show works; `repo_path` = non-existent so
          // deleteTask's git-worktree-remove fails gracefully without deleting cwd.
          insertWorktreeIfAbsent({
            id: wtId,
            path: process.cwd(),
            repo_path: '/tmp/e2e-norepo',
            branch: 'review/e2e',
            base_branch: 'main',
            mode: 'new',
            status: 'available',
          });

          insertTaskIfAbsent({
            id: body.task.id,
            title: body.task.title,
            description: '',
            runtime_state: 'idle',
            workflow_status: 'backlog',
            source: 'auto_review',
            worktree_id: wtId,
            pr_url: body.task.pr_url,
            pr_number: body.task.pr_number,
            pr_head_sha: body.task.pr_head_sha,
          });

          seedReviewRun({
            id: body.review_run.id,
            task_id: body.task.id,
            pr_head_sha: body.task.pr_head_sha,
            walkthrough: body.review_run.walkthrough,
          });

          for (const c of body.comments) {
            seedInlineComment({
              id: c.id,
              task_id: body.task.id,
              review_run_id: body.review_run.id,
              file_path: c.file_path,
              line: c.line,
              side: c.side,
              original_commit_sha: body.task.pr_head_sha,
              body: c.body,
              kind: c.kind,
              severity: c.severity ?? null,
              bucket: c.bucket ?? null,
              existing_code: c.existing_code ?? null,
              suggested_code: c.suggested_code ?? null,
            });
          }
        });

        res.json({ task_id: body.task.id });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
