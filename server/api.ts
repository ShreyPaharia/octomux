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
import * as diffMod from './diff.js';
import { taskWorkingDir } from './task-paths.js';
import { parseDiffRange } from './diff-range.js';
import {
  BaseBranchMissingError,
  BaseUnavailableError,
  clearDiffBaseCache,
  resolveDiffBase,
  resolveRef,
} from './diff-base.js';
import { listBranches, listCommits } from './git-commits.js';
import { setReviewed, clearReviewed } from './repositories/file-review-state.js';
import {
  listComments,
  getComment,
  resolveComment,
  unresolveComment,
  updateCommentBody,
  deleteComment,
  seedInlineComment,
} from './repositories/inline-comments.js';
import { computeOutdated } from './inline-comments-outdated.js';
import { sendMessageToAgent } from './tmux-input.js';
import { listReviewsInbox, getReviewDetail } from './reviews-inbox.js';
import {
  getReviewRun,
  getCurrentRun,
  setWalkthrough,
  seedReviewRun,
} from './repositories/review-runs.js';
import { listPublishedReviews } from './repositories/published-reviews.js';
import { addLearning } from './repositories/review-learnings.js';
import { updateCommentFields } from './repositories/inline-comments.js';
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
  touchUpdatedAt,
  setWorktreeBase,
  setCurrentSummary,
  addTaskUpdate,
  listTaskUpdates,
  getTaskExternalRefs,
  getTaskExternalRef,
  upsertTaskExternalRef,
  deleteTaskExternalRef,
  findExistingReviewTask,
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
  listTrackedRepoPaths,
  insertWorktreeIfAbsent,
  insertTaskIfAbsent,
  inTransaction,
} from './repositories/index.js';

import { createInlineComment } from './services/comment-service.js';
import { createTask } from './services/task-service.js';
import {
  createReviewTaskFromPr,
  createManualReview,
  triggerReviewRun,
} from './services/review-service.js';
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

import {
  loadTaskOrFail,
  lookupExistingReviewId,
  deepMerge,
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

  // ─── Diff ──────────────────────────────────────────────────────────────────

  app.get('/api/tasks/:id/diff', async (req: Request, res: Response) => {
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
      const summary = await diffMod.getDiffSummary({ task, range });
      res.json(summary);
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

  app.get('/api/tasks/:id/diff/*path', async (req: Request, res: Response) => {
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
      diffMod.safeResolvePath(cwd, relPath);
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
      const diff = await diffMod.getFileDiff({
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

  // ─── Branches / commits / base mutation ─────────────────────────────────────

  app.get('/api/tasks/:id/branches', async (req: Request, res: Response) => {
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
      apiLogger.warn({ task_id: task.id, err: (err as Error).message }, 'listBranches failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/tasks/:id/commits', async (req: Request, res: Response) => {
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
      apiLogger.warn({ task_id: task.id, err: (err as Error).message }, 'listCommits failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/tasks/:id/base', async (req: Request, res: Response) => {
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
      apiLogger.warn(
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

    apiLogger.info(
      { task_id: task.id, base_branch: baseBranch, base_sha: sha },
      'task base changed',
    );

    broadcast({ type: 'task:updated', payload: { taskId: task.id } });

    const reloaded = getTaskRepo(task.id);
    res.json(reloaded);
  });

  // ─── File review state ─────────────────────────────────────────────────────

  app.post('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const cwd = taskWorkingDir(task);
    if (!cwd) {
      res.status(400).json({ error: 'Task has no worktree' });
      return;
    }
    const params = req.params as Record<string, string | string[]>;
    const rawPath = params.path ?? params['0'] ?? '';
    const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
    try {
      diffMod.safeResolvePath(cwd, relPath);
    } catch {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    try {
      const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', 'HEAD']);
      const headSha = stdout.trim();
      // Capture the blob hash of the content actually reviewed (the working
      // tree), so "changed since review" reacts to uncommitted edits too. Null
      // when the file is gone (e.g. a reviewed deletion).
      let blobSha: string | null = null;
      try {
        const { stdout: bs } = await execFile('git', ['-C', cwd, 'hash-object', '--', relPath]);
        blobSha = bs.trim() || null;
      } catch {
        blobSha = null;
      }
      setReviewed(task.id, relPath, headSha, blobSha);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const cwd = taskWorkingDir(task);
    if (!cwd) {
      res.status(400).json({ error: 'Task has no worktree' });
      return;
    }
    const params = req.params as Record<string, string | string[]>;
    const rawPath = params.path ?? params['0'] ?? '';
    const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
    try {
      diffMod.safeResolvePath(cwd, relPath);
    } catch {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    clearReviewed(task.id, relPath);
    res.status(204).send();
  });

  // ─── Inline review comments ────────────────────────────────────────────────

  app.post('/api/tasks/:id/comments', async (req: Request, res: Response) => {
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
    if (!fs.existsSync(cwd)) {
      res.status(400).json({ error: 'Worktree no longer exists on disk' });
      return;
    }

    const body = req.body as {
      file_path?: unknown;
      line?: unknown;
      side?: unknown;
      body?: unknown;
      agent_id?: unknown;
      anchor_commit_sha?: unknown;
    };

    const filePath = typeof body.file_path === 'string' ? body.file_path : '';
    const lineRaw = body.line;
    const side = body.side;
    const commentBody = typeof body.body === 'string' ? body.body : '';
    const agentId = typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null;
    const anchorRaw = body.anchor_commit_sha;

    if (!filePath) {
      res.status(400).json({ error: 'file_path is required' });
      return;
    }
    if (typeof lineRaw !== 'number' || !Number.isInteger(lineRaw) || lineRaw < 1) {
      res.status(400).json({ error: 'line must be a positive integer' });
      return;
    }
    if (side !== 'old' && side !== 'new') {
      res.status(400).json({ error: "side must be 'old' or 'new'" });
      return;
    }
    if (!commentBody.trim()) {
      res.status(400).json({ error: 'body is required' });
      return;
    }
    if (anchorRaw !== undefined && typeof anchorRaw !== 'string') {
      res.status(400).json({ error: 'anchor_commit_sha must be a string' });
      return;
    }

    try {
      diffMod.safeResolvePath(cwd, filePath);
    } catch {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    if (!task.base_sha) {
      res.status(400).json({ error: 'base_sha not available for this task' });
      return;
    }

    try {
      const row = await createInlineComment({
        cwd,
        task_id: task.id,
        base_sha: task.base_sha,
        file_path: filePath,
        line: lineRaw as number,
        side: side as 'old' | 'new',
        body: commentBody,
        agent_id: agentId,
        anchor_commit_sha: anchorRaw as string | undefined,
      });
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof ServiceError) {
        res.status(err.status).json({ error: err.message });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  app.get('/api/tasks/:id/comments', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const fileFilter = typeof req.query.file === 'string' ? req.query.file : undefined;
    const rows = listComments(task.id, fileFilter ? { file: fileFilter } : undefined);

    const cwd = taskWorkingDir(task);
    const haveWorktree = !!cwd && fs.existsSync(cwd) && task.run_mode !== 'scratch';

    if (!haveWorktree || !task.base_sha) {
      res.json({
        comments: rows.map((r) => ({ ...r, outdated: false })),
        outdated_unavailable: true,
      });
      return;
    }

    try {
      const map = await computeOutdated(cwd!, task.base_sha, rows);
      res.json({
        comments: rows.map((r) => ({ ...r, outdated: map.get(r.id) ?? false })),
      });
    } catch (err) {
      apiLogger.warn(
        { task_id: task.id, err: (err as Error).message },
        'computeOutdated failed; returning comments without outdated flag',
      );
      res.json({
        comments: rows.map((r) => ({ ...r, outdated: false })),
        outdated_unavailable: true,
      });
    }
  });

  app.patch('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const cid = (req.params as Record<string, string>).cid;
    const existing = getComment(cid);
    if (!existing || existing.task_id !== task.id) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    // Refuse updates on already-published comments
    if (existing.status === 'published') {
      res.status(409).json({ error: 'Cannot update a published comment' });
      return;
    }

    const body = req.body as {
      resolved?: unknown;
      body?: unknown;
      status?: unknown;
      bucket?: unknown;
      kind?: unknown;
      severity?: unknown;
      existing_code?: unknown;
      suggested_code?: unknown;
      rejection_why?: unknown;
    };
    const hasResolved = body.resolved !== undefined;
    const hasBody = body.body !== undefined;
    const hasStatus = body.status !== undefined;
    const hasExtended =
      body.bucket !== undefined ||
      body.kind !== undefined ||
      body.severity !== undefined ||
      body.existing_code !== undefined ||
      body.suggested_code !== undefined;

    const VALID_STATUSES = ['draft', 'accepted', 'rejected', 'stale'];

    if (!hasResolved && !hasBody && !hasStatus && !hasExtended) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }
    if (hasResolved && typeof body.resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved must be a boolean' });
      return;
    }
    if (hasBody && (typeof body.body !== 'string' || !body.body.trim())) {
      res.status(400).json({ error: 'body must be a non-empty string' });
      return;
    }
    if (hasStatus && !VALID_STATUSES.includes(body.status as string)) {
      res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
      return;
    }

    let row = existing;

    if (hasBody) {
      const updated = updateCommentBody(cid, body.body as string);
      if (updated) row = updated;
    }
    if (hasResolved) {
      const updated = (body.resolved as boolean) ? resolveComment(cid) : unresolveComment(cid);
      if (updated) row = updated;
    }
    if (hasStatus || hasExtended) {
      const fields: import('./repositories/inline-comments.js').UpdateCommentFields = {};
      if (hasStatus) fields.status = body.status as import('./types.js').CommentStatus;
      if (body.bucket !== undefined)
        fields.bucket = body.bucket as import('./types.js').CommentBucket | null;
      if (body.kind !== undefined) fields.kind = body.kind as import('./types.js').CommentKind;
      if (body.severity !== undefined)
        fields.severity = body.severity as import('./types.js').CommentSeverity | null;
      if (body.existing_code !== undefined)
        fields.existing_code = body.existing_code as string | null;
      if (body.suggested_code !== undefined)
        fields.suggested_code = body.suggested_code as string | null;
      const updated = updateCommentFields(cid, fields);
      if (updated) row = updated;
    }

    // Capture rejection learning if status='rejected' and rejection_why provided
    if (
      body.status === 'rejected' &&
      typeof body.rejection_why === 'string' &&
      body.rejection_why.trim()
    ) {
      const repoPath = task.repo_path ?? '';
      if (repoPath) {
        addLearning({
          repo_path: repoPath,
          why: body.rejection_why.trim(),
          created_from_comment_id: cid,
        });
      }
    }

    res.json(row);
  });

  app.delete('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const cid = (req.params as Record<string, string>).cid;
    const existing = getComment(cid);
    if (!existing || existing.task_id !== task.id) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    deleteComment(cid);
    res.status(204).send();
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

  // ─── Reviews inbox ───────────────────────────────────────────────────────────

  // GET /api/reviews — list all auto_review tasks with aggregated counts
  app.get('/api/reviews', (_req: Request, res: Response) => {
    try {
      res.json(listReviewsInbox());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/reviews/:id — full detail for a single review task
  app.get('/api/reviews/:id', (req: Request, res: Response) => {
    try {
      const detail = getReviewDetail((req.params as Record<string, string>).id);
      if (!detail) {
        res.status(404).json({ error: 'Review not found' });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/reviews — create an auto_review task for a GitHub PR URL.
  // Idempotent: if a live (non-deleted, non-error) review task already exists
  // for the same repo+PR, returns that instead of creating a duplicate.
  app.post('/api/reviews', async (req: Request, res: Response) => {
    const body = req.body as { pr_url?: unknown; repo_path?: unknown };
    const prUrl = typeof body.pr_url === 'string' ? body.pr_url.trim() : '';
    const bodyRepoPath = typeof body.repo_path === 'string' ? body.repo_path.trim() : '';

    // Parse GitHub PR URL
    const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!prMatch) {
      res.status(400).json({ error: 'invalid pr_url' });
      return;
    }
    const [, owner, repo, numberStr] = prMatch;
    const number = parseInt(numberStr, 10);
    const ownerRepo = `${owner}/${repo}`;

    // Resolve the local repo path
    let repoPath = bodyRepoPath;
    if (!repoPath) {
      const rows = listTrackedRepoPaths();

      for (const row of rows) {
        const candidatePath = row.repo_path;
        try {
          const { stdout } = await execFile('git', [
            '-C',
            candidatePath,
            'remote',
            'get-url',
            'origin',
          ]);
          const remoteUrl = stdout.trim();
          // Handle both ssh (git@github.com:owner/repo.git) and https
          const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
          const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
          const remoteOwnerRepo = (sshMatch?.[1] ?? httpsMatch?.[1] ?? '').toLowerCase();
          if (remoteOwnerRepo === ownerRepo.toLowerCase()) {
            repoPath = candidatePath;
            break;
          }
        } catch {
          // skip this candidate
        }
      }
    }

    if (!repoPath) {
      res.status(400).json({
        error: `could not resolve a local repo for ${ownerRepo}; pass repo_path`,
      });
      return;
    }

    // Dedup: check for an existing live review task for this repo+PR
    const existing = findExistingReviewTask(repoPath, number);

    if (existing) {
      res.status(200).json({ id: existing.id, reused: true });
      return;
    }

    // Fetch PR metadata via gh CLI
    let pr: {
      title: string;
      headRefOid: string;
      baseRefName: string;
      author: { login: string } | null;
      state: string;
      url: string;
    };
    try {
      const { stdout } = await execFile(
        'gh',
        [
          'pr',
          'view',
          String(number),
          '--repo',
          ownerRepo,
          '--json',
          'title,headRefOid,baseRefName,author,state,url',
        ],
        { cwd: repoPath },
      );
      pr = JSON.parse(stdout) as typeof pr;
    } catch (err) {
      res.status(400).json({ error: `failed to fetch PR metadata: ${(err as Error).message}` });
      return;
    }

    if (pr.state !== 'OPEN') {
      res.status(400).json({ error: `PR #${number} is ${pr.state}` });
      return;
    }

    // Create the review task (service owns the build+insert+broadcast+startTask tail).
    const { id } = await createReviewTaskFromPr({
      repo_path: repoPath,
      pr_number: number,
      pr_url: pr.url,
      pr_head_sha: pr.headRefOid,
      base_branch: pr.baseRefName,
      title: pr.title,
      author: pr.author?.login ?? null,
      requested_at: new Date().toISOString(),
    });

    apiLogger.info(
      { task_id: id, pr_number: number, repo: ownerRepo, repo_path: repoPath },
      'review create task created',
    );

    res.status(201).json({ id, reused: false });
  });

  // ─── Review runs ─────────────────────────────────────────────────────────────

  // PATCH /api/tasks/:id/review-runs/:rid/walkthrough — deep-merge walkthrough
  app.patch('/api/tasks/:id/review-runs/:rid/walkthrough', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const params = req.params as Record<string, string>;
    const rid = params.rid;

    const run = getReviewRun(rid);
    if (!run || run.task_id !== task.id) {
      res.status(404).json({ error: 'Review run not found' });
      return;
    }

    // Refuse if a published_reviews row exists for this run's pr_head_sha
    const published = listPublishedReviews(task.id);
    const alreadyPublished = published.some((p) => p.head_sha === run.pr_head_sha);
    if (alreadyPublished) {
      res.status(409).json({ error: 'Review already published for this head SHA' });
      return;
    }

    // Deep-merge incoming body into existing walkthrough JSON
    const existing = run.walkthrough ? JSON.parse(run.walkthrough) : {};
    const incoming = req.body as Record<string, unknown>;
    const merged = deepMerge(existing, incoming);
    setWalkthrough(rid, JSON.stringify(merged));

    const updated = getReviewRun(rid);
    res.json(updated);
  });

  // POST /api/tasks/:id/review-runs — trigger a manual re-review
  app.post('/api/tasks/:id/review-runs', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    // 409 if a run with status='running' already exists for this task
    const currentRun = getCurrentRun(task.id);
    if (currentRun?.status === 'running') {
      res.status(409).json({ error: 'A review run is already in progress' });
      return;
    }

    try {
      await triggerReviewRun(task);
      res.status(202).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/tasks/:id/publish-review — publish accepted draft comments to GitHub
  app.post('/api/tasks/:id/publish-review', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const body = req.body as { verdict?: unknown; review_body?: unknown };
    const verdict = body.verdict ?? 'COMMENT';

    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(verdict as string)) {
      res.status(400).json({ error: 'verdict must be one of COMMENT, APPROVE, REQUEST_CHANGES' });
      return;
    }

    try {
      const { publishReview } = await import('./publish-review.js');
      const result = await publishReview(
        task.id,
        verdict as import('./types.js').PublishedReviewVerdict,
        typeof body.review_body === 'string' ? body.review_body : '',
      );
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('No accepted comments')) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // POST /api/tasks/:taskId/review — manually trigger a review for this task.
  // Creates an auto_review task pointing back at the source via review_of_task_id,
  // or returns the existing review when one is already present.
  app.post('/api/tasks/:taskId/review', async (req: Request, res: Response) => {
    const taskId = (req.params as Record<string, string>).taskId;
    const task = getTaskRepo(taskId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (!task.branch || !task.worktree) {
      res.status(400).json({ error: 'Start the task first' });
      return;
    }

    const existingId = lookupExistingReviewId(task);
    if (existingId) {
      res.status(200).json({ id: existingId, action: 'existing' });
      return;
    }

    // PR-less source: capture the current HEAD of the source worktree so the
    // review agent has a concrete sha to diff base..head against.
    let prHeadSha = task.pr_head_sha;
    if (!prHeadSha) {
      const cwd = taskWorkingDir(task);
      try {
        const { stdout } = await execFile('git', ['-C', cwd!, 'rev-parse', 'HEAD']);
        prHeadSha = stdout.trim();
      } catch (err) {
        res.status(500).json({ error: `failed to resolve HEAD: ${(err as Error).message}` });
        return;
      }
    }

    const { id: newId } = await createManualReview({
      source_task_id: task.id,
      source_title: task.title,
      repo_path: task.repo_path,
      branch: task.branch,
      base_branch: task.base_branch,
      base_sha: task.base_sha ?? null,
      pr_head_sha: prHeadSha,
      pr_url: task.pr_url ?? null,
      pr_number: task.pr_number ?? null,
      requested_at: new Date().toISOString(),
    });

    res.status(201).json({ id: newId, action: 'created' });
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
