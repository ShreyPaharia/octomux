import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import { getNeedsYou, getActivity } from './inbox.js';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import {
  startTask,
  closeTask,
  deleteTask,
  resumeTask,
  addAgent,
  stopAgent,
  createUserTerminal,
  createShellTerminal,
  closeShellTerminal,
  hopAgent,
} from './task-runner.js';
import * as diffMod from './diff.js';
import { parseDiffRange } from './diff-range.js';
import { BaseUnavailableError, clearDiffBaseCache, resolveDiffBase, resolveRef } from './diff-base.js';
import { listBranches, listCommits } from './git-commits.js';
import { setReviewed, clearReviewed } from './file-review-state.js';
import {
  addComment,
  listComments,
  getComment,
  resolveComment,
  unresolveComment,
  updateCommentBody,
  deleteComment,
} from './inline-comments.js';
import { computeOutdated, splitLines } from './inline-comments-outdated.js';
import { createChat, listChats, getChat, closeChat, deleteChat } from './chats.js';
import { SELECT_TASK_SQL } from './task-select.js';

import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from './skills.js';
import {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
} from './integrations/store.js';
import { listProviders, getProvider } from './integrations/registry.js';
import { maskIntegration, mergeMaskedConfig } from './integrations/mask.js';
// Side-effect: ensure all providers are registered when the API is loaded.
import './integrations/index.js';
import {
  listAgents,
  getAgent,
  saveAgent,
  resetAgent,
  createAgent,
  deleteAgent,
  isBuiltInAgent,
  syncAgents,
} from './agents.js';
import { getSettings, updateSettings } from './settings.js';
import { getOrCreateRepoConfig, updateRepoConfig, listRepoConfigs } from './repo-config.js';
import { hookRoutes } from './hooks.js';
import { broadcast } from './events.js';
import { generateTitleAndDescription } from './title-gen.js';
import { invalidateHookEnabledCache } from './hook-dispatcher.js';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Task,
  Agent,
  DerivedTaskStatus,
  UserTerminal,
  RunMode,
  Worktree,
  WorktreeSummary,
  CreateChatRequest,
  MoveTaskRequest,
  SummaryRequest,
  NoteRequest,
  AddRefRequest,
  TaskExternalRef,
  TaskUpdate,
} from './types.js';
import { RUN_MODES, WORKFLOW_STATUSES } from './types.js';
import { fireHook, getTaskHookExecutions } from './hook-dispatcher.js';

const execFile = promisify(execFileCb);
const apiLogger = childLogger('api');

const TERMINALS_BY_TASK_SQL =
  'SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index';

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** Load a task by :id param; respond 404 and return null if missing. */
function loadTaskOrFail(req: Request, res: Response): Task | null {
  const task = getDb().prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(req.params.id) as
    | Task
    | undefined;
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  return task;
}

/** Map a thrown domain error to an HTTP response. */
function sendDomainError(res: Response, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  const msg = e.message || 'Unknown error';
  if (e.code === 'ENOENT' || msg.includes('not found') || msg.includes('does not exist')) {
    res.status(404).json({ error: msg });
  } else if (msg.includes('already exists')) {
    res.status(409).json({ error: msg });
  } else if (msg.startsWith('Invalid') || msg.includes('required')) {
    res.status(400).json({ error: msg });
  } else {
    res.status(500).json({ error: msg });
  }
}

/** Reload a task with its related agents and user_terminals. */
function fetchTaskBundle(taskId: string): Task {
  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task;
  task.agents = db
    .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
    .all(taskId) as Agent[];
  task.user_terminals = db.prepare(TERMINALS_BY_TASK_SQL).all(taskId) as UserTerminal[];
  return task;
}

function derivedStatus(task: {
  runtime_state: string;
  agents: Array<{ status: string; hook_activity: string }>;
}): DerivedTaskStatus | null {
  if (task.runtime_state !== 'running') return null;
  const activities = task.agents.filter((a) => a.status !== 'stopped').map((a) => a.hook_activity);
  if (activities.length === 0) return 'done';
  if (activities.includes('active')) return 'working';
  if (activities.includes('waiting')) return 'needs_attention';
  return 'done';
}

export function setupRoutes(app: Express): void {
  app.use('/api/hooks', hookRoutes);

  // Browse directories for folder picker
  app.get('/api/browse', async (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || os.homedir();

    try {
      const stat = await fs.promises.stat(dirPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Path does not exist' });
      return;
    }

    const dirEntries = await fs.promises.readdir(dirPath);
    const resolved = await Promise.all(
      dirEntries.map(
        async (name): Promise<{ name: string; path: string; isGit: boolean } | null> => {
          const fullPath = path.join(dirPath, name);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (!stat.isDirectory()) return null;
            const isGit = await fs.promises
              .access(path.join(fullPath, '.git'))
              .then(() => true)
              .catch(() => false);
            return { name, path: fullPath, isGit };
          } catch {
            return null;
          }
        },
      ),
    );
    const entries = resolved.filter(
      (e): e is { name: string; path: string; isGit: boolean } => e !== null,
    );

    entries.sort((a, b) => {
      if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
      const aHidden = a.name.startsWith('.');
      const bHidden = b.name.startsWith('.');
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const parent = path.dirname(dirPath);
    res.json({
      current: dirPath,
      parent: parent !== dirPath ? parent : null,
      entries,
    });
  });

  // List branches for a git repo
  app.get('/api/branches', async (req: Request, res: Response) => {
    const repoPath = req.query.repo_path as string;
    if (!repoPath) {
      res.status(400).json({ error: 'repo_path is required' });
      return;
    }

    try {
      const { stdout } = await execFile('git', [
        '-C',
        repoPath,
        'branch',
        '-a',
        '--format=%(refname:short)',
      ]);
      const branches = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((b) => b.replace(/^origin\//, ''));
      // Deduplicate (local + remote may overlap)
      const unique = [...new Set(branches)].filter((b) => b !== 'HEAD');
      res.json(unique);
    } catch {
      res.status(400).json({ error: 'Failed to list branches' });
    }
  });

  // Preflight check for none-mode task creation
  app.get('/api/preflight/none-mode', async (req: Request, res: Response) => {
    const repoPath = String(req.query.repo_path ?? '');
    const baseBranch = String(req.query.base_branch ?? '');
    if (!repoPath || !baseBranch) {
      res.status(400).json({ error: 'repo_path and base_branch are required' });
      return;
    }
    try {
      const { preflightNoneMode } = await import('./preflight.js');
      const result = await preflightNoneMode(repoPath, baseBranch);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Stash uncommitted changes before switching branch
  app.post('/api/preflight/stash', async (req: Request, res: Response) => {
    const repoPath = String(req.body?.repo_path ?? '');
    const targetBranch = String(req.body?.target_branch ?? '');
    if (!repoPath || !targetBranch) {
      res.status(400).json({ error: 'repo_path and target_branch are required' });
      return;
    }
    try {
      await execFile('git', [
        '-C',
        repoPath,
        'stash',
        'push',
        '-u',
        '-m',
        `octomux: auto-stash before switching to ${targetBranch}`,
      ]);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Get default branch for a git repo
  app.get('/api/default-branch', async (req: Request, res: Response) => {
    const repoPath = req.query.repo_path as string;
    if (!repoPath) {
      res.status(400).json({ error: 'repo_path is required' });
      return;
    }

    try {
      const { stdout } = await execFile('git', [
        '-C',
        repoPath,
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
      ]);
      const branch = stdout.trim().replace('refs/remotes/origin/', '');
      res.json({ branch });
    } catch {
      // Fallback to 'main'
      res.json({ branch: 'main' });
    }
  });

  // Recent repository paths from past tasks
  app.get('/api/recent-repos', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT w.repo_path AS repo_path, MAX(t.created_at) as last_used
           FROM tasks t
           INNER JOIN worktrees w ON t.worktree_id = w.id
          WHERE w.repo_path IS NOT NULL
          GROUP BY w.repo_path
          ORDER BY last_used DESC
          LIMIT 10`,
      )
      .all() as Array<{ repo_path: string; last_used: string }>;
    res.json(rows);
  });

  // List all tasks with agents
  app.get('/api/tasks', (req: Request, res: Response) => {
    const db = getDb();
    const repoPath = req.query.repo_path as string | undefined;

    let tasks: Task[];
    if (repoPath) {
      tasks = db
        .prepare(`${SELECT_TASK_SQL} WHERE w.repo_path = ? ORDER BY t.created_at DESC`)
        .all(repoPath) as Task[];
    } else {
      tasks = db.prepare(`${SELECT_TASK_SQL} ORDER BY t.created_at DESC`).all() as Task[];
    }

    if (tasks.length === 0) {
      res.json([]);
      return;
    }

    // Bulk-fetch all related data for the matching tasks
    const taskIds = tasks.map((t) => t.id);
    const placeholders = taskIds.map(() => '?').join(',');

    const allAgents = db
      .prepare(`SELECT * FROM agents WHERE task_id IN (${placeholders}) ORDER BY window_index`)
      .all(...taskIds) as Agent[];

    const allPrompts = db
      .prepare(
        `SELECT pp.*, a.label as agent_label
         FROM permission_prompts pp
         LEFT JOIN agents a ON pp.agent_id = a.id
         WHERE pp.task_id IN (${placeholders}) AND pp.status = 'pending'
         ORDER BY pp.created_at ASC`,
      )
      .all(...taskIds) as Array<Record<string, unknown>>;

    const allTerminals = db
      .prepare(
        `SELECT * FROM user_terminals WHERE task_id IN (${placeholders}) ORDER BY window_index`,
      )
      .all(...taskIds) as UserTerminal[];

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
      list.push({ ...pp, tool_input: safeParseJson(pp.tool_input as string) });
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
    const db = getDb();
    const info = db.prepare(`UPDATE tasks SET last_viewed_at = datetime('now')`).run();
    apiLogger.info(
      { operation: 'marked_all_viewed', updated: info.changes },
      'marked all tasks viewed',
    );
    res.json({ updated: info.changes });
  });

  // Mark a single task viewed
  app.patch('/api/tasks/:id/viewed', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();
    db.prepare(`UPDATE tasks SET last_viewed_at = datetime('now') WHERE id = ?`).run(task.id);
    apiLogger.info({ task_id: task.id, operation: 'marked_viewed' }, 'marked task viewed');
    const updated = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(task.id) as Task;
    res.json(updated);
  });

  // Get single task with agents
  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();
    const agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
    const pendingPrompts = db
      .prepare(
        `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id = ? AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
      )
      .all(task.id) as Array<Record<string, unknown>>;
    const parsedPrompts = pendingPrompts.map((pp) => ({
      ...pp,
      tool_input: safeParseJson(pp.tool_input as string),
    }));
    const userTerminals = db.prepare(TERMINALS_BY_TASK_SQL).all(task.id) as UserTerminal[];
    const worktreeRow = task.worktree_id
      ? ((db.prepare('SELECT * FROM worktrees WHERE id = ?').get(task.worktree_id) as
          | Worktree
          | undefined) ?? null)
      : null;
    res.json({
      ...task,
      agents,
      pending_prompts: parsedPrompts,
      derived_status: derivedStatus({ runtime_state: task.runtime_state, agents }),
      user_terminals: userTerminals,
      worktree_row: worktreeRow,
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

    // B5: server-side title/description generation
    let resolvedTitle = body.title;
    let resolvedDescription = body.description;
    if (body.initial_prompt && (!resolvedTitle || !resolvedDescription)) {
      const generated = await generateTitleAndDescription(body.initial_prompt);
      if (!resolvedTitle) resolvedTitle = generated.title;
      if (!resolvedDescription) resolvedDescription = generated.description;
    }
    // Fallback to ensure non-empty strings
    resolvedTitle =
      resolvedTitle || body.initial_prompt?.split('\n')[0]?.slice(0, 80) || 'Untitled task';
    resolvedDescription = resolvedDescription || body.initial_prompt || '';

    const db = getDb();
    const id = nanoid(12);
    const isDraft = !!body.draft;

    // Phase 2a: worktrees owns path/branch/base/repo. Always create a
    // worktree row at task creation. For `new` mode the path isn't known
    // until setup runs (derived from slug); stage it as empty string and
    // task-runner updates it when the git worktree is cut.
    const worktreeId = nanoid(12);
    const stagedPath =
      runMode === 'existing' ? storedWorktree! : runMode === 'none' ? storedRepoPath : '';
    try {
      db.prepare(
        `INSERT INTO worktrees
           (id, path, repo_path, branch, base_branch, mode, status)
         VALUES (?, ?, ?, ?, ?, ?, 'available')`,
      ).run(
        worktreeId,
        stagedPath,
        runMode === 'scratch' ? null : storedRepoPath || null,
        body.branch ?? null,
        body.base_branch ?? null,
        runMode,
      );

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

      db.prepare(
        `INSERT INTO tasks
           (id, title, description, runtime_state, workflow_status, initial_prompt, worktree_id, agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        resolvedTitle,
        resolvedDescription,
        isDraft ? 'idle' : 'setting_up',
        initialWorkflowStatus,
        body.initial_prompt ?? null,
        worktreeId,
        body.agent ?? null,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (String(e.message).includes('UNIQUE constraint')) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw err;
    }

    const created = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(id) as Task;
    created.agents = [];
    created.user_terminals = [];
    broadcast({ type: 'task:created', payload: { taskId: id } });

    if (!isDraft) {
      // Fire-and-forget: startTask runs in background, broadcasts task:updated when done
      startTask(created)
        .then(() => {
          broadcast({ type: 'task:updated', payload: { taskId: id } });
        })
        .catch(() => {
          // startTask already sets error status in its own catch block
          broadcast({ type: 'task:updated', payload: { taskId: id } });
        });
    }

    res.status(201).json(created);
  });

  // Update task status
  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    const body = req.body as UpdateTaskRequest;
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();

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
      const taskFields: string[] = [];
      const taskValues: unknown[] = [];
      for (const key of ['title', 'description', 'initial_prompt'] as const) {
        if (body[key] !== undefined) {
          taskFields.push(`${key} = ?`);
          taskValues.push(body[key] ?? null);
        }
      }
      if (taskFields.length > 0) {
        taskFields.push(`updated_at = datetime('now')`);
        taskValues.push(task.id);
        db.prepare(`UPDATE tasks SET ${taskFields.join(', ')} WHERE id = ?`).run(...taskValues);
      }

      const worktreeFields: string[] = [];
      const worktreeValues: unknown[] = [];
      if (body.repo_path !== undefined) {
        worktreeFields.push('repo_path = ?');
        worktreeValues.push(body.repo_path ?? null);
      }
      if (body.branch !== undefined) {
        worktreeFields.push('branch = ?');
        worktreeValues.push(body.branch ?? null);
      }
      if (body.base_branch !== undefined) {
        worktreeFields.push('base_branch = ?');
        worktreeValues.push(body.base_branch ?? null);
      }
      if (body.worktree_path !== undefined) {
        worktreeFields.push('path = ?');
        worktreeValues.push(body.worktree_path ?? '');
      }
      if (body.run_mode !== undefined) {
        worktreeFields.push('mode = ?');
        worktreeValues.push(body.run_mode);
      }
      if (worktreeFields.length > 0) {
        let wtId = task.worktree_id;
        if (!wtId) {
          // Materialise a placeholder worktree row for this draft; fields get
          // refined as the user edits or at setup time.
          wtId = nanoid(12);
          db.prepare(
            `INSERT INTO worktrees (id, path, mode, status) VALUES (?, '', ?, 'available')`,
          ).run(wtId, body.run_mode ?? task.run_mode ?? 'new');
          db.prepare(`UPDATE tasks SET worktree_id = ? WHERE id = ?`).run(wtId, task.id);
        }
        worktreeValues.push(wtId);
        db.prepare(`UPDATE worktrees SET ${worktreeFields.join(', ')} WHERE id = ?`).run(
          ...worktreeValues,
        );
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
      getDb()
        .prepare(`UPDATE tasks SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(body.workflow_status, task.id);
    }

    const updated = fetchTaskBundle(task.id);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json(updated);
  });

  // Start a draft task
  app.post('/api/tasks/:id/start', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();

    if (task.runtime_state !== 'idle') {
      res.status(400).json({ error: 'Only draft tasks can be started' });
      return;
    }

    // Set status immediately so client sees setting_up
    db.prepare(
      `UPDATE tasks SET runtime_state = 'setting_up', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

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

  // Delete task
  app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();

    const taskId = task.id;
    await deleteTask(task);
    // ON DELETE CASCADE removes agents, permission_prompts, user_terminals
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    broadcast({ type: 'task:deleted', payload: { taskId } });
    res.status(204).send();
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
    const agent = await addAgent(task, body.prompt, body.agent);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(201).json(agent);
  });

  // Stop agent
  app.delete('/api/tasks/:id/agents/:agentId', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const agent = getDb()
      .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
      .get(req.params.agentId, req.params.id) as Agent | undefined;

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

    const terminal = getDb()
      .prepare('SELECT * FROM user_terminals WHERE id = ? AND task_id = ?')
      .get(req.params.terminalId, req.params.id) as UserTerminal | undefined;

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

    const agent = getDb()
      .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
      .get(req.params.agentId, req.params.id) as Agent | undefined;

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { message } = req.body as { message?: string };
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    await execFile('tmux', [
      'send-keys',
      '-t',
      `${task.tmux_session}:${agent.window_index}`,
      message,
      'Enter',
    ]);

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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    getDb()
      .prepare(`UPDATE worktrees SET base_branch = ?, base_sha = ? WHERE id = ?`)
      .run(baseBranch, sha, task.worktree_id);
    getDb().prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(task.id);

    // Invalidate any cached origin tip for old/new branch on this worktree so
    // the next diff fetch resolves fresh.
    if (task.base_branch) clearDiffBaseCache(cwd, task.base_branch);
    clearDiffBaseCache(cwd, baseBranch);

    apiLogger.info(
      { task_id: task.id, base_branch: baseBranch, base_sha: sha },
      'task base changed',
    );

    broadcast({ type: 'task:updated', payload: { taskId: task.id } });

    const reloaded = getDb().prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(task.id) as
      | Task
      | undefined;
    res.json(reloaded);
  });

  // ─── File review state ─────────────────────────────────────────────────────

  app.post('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
      setReviewed(task.id, relPath, headSha);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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
    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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

    let anchorSha: string;
    if (anchorRaw && typeof anchorRaw === 'string') {
      anchorSha = anchorRaw;
    } else {
      try {
        const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', 'HEAD']);
        anchorSha = stdout.trim();
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
    }

    if (!task.base_sha) {
      res.status(400).json({ error: 'base_sha not available for this task' });
      return;
    }

    let fileDiff: diffMod.FileDiff;
    try {
      fileDiff = await diffMod.getFileDiff({
        worktree: cwd,
        base: task.base_sha,
        relPath: filePath,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
    if (fileDiff.binary) {
      res.status(400).json({ error: 'cannot comment on binary file' });
      return;
    }

    let anchoredContent: string;
    try {
      const { stdout } = await execFile('git', ['-C', cwd, 'show', `${anchorSha}:${filePath}`]);
      anchoredContent = stdout;
    } catch {
      res.status(400).json({ error: 'file not found at anchor commit' });
      return;
    }

    const anchoredLineCount = splitLines(anchoredContent).length;
    if (lineRaw > anchoredLineCount) {
      res.status(400).json({ error: 'line out of range at anchor commit' });
      return;
    }

    try {
      const row = addComment({
        task_id: task.id,
        agent_id: agentId,
        file_path: filePath,
        line: lineRaw,
        side,
        original_commit_sha: anchorSha,
        body: commentBody,
      });
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/tasks/:id/comments', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;

    const fileFilter = typeof req.query.file === 'string' ? req.query.file : undefined;
    const rows = listComments(task.id, fileFilter ? { file: fileFilter } : undefined);

    const cwd = task.run_mode === 'none' ? task.repo_path : task.worktree;
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

    const body = req.body as { resolved?: unknown; body?: unknown };
    const hasResolved = body.resolved !== undefined;
    const hasBody = body.body !== undefined;

    if (!hasResolved && !hasBody) {
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

    let row = existing;
    if (hasBody) {
      const updated = updateCommentBody(cid, body.body as string);
      if (updated) row = updated;
    }
    if (hasResolved) {
      const updated = (body.resolved as boolean) ? resolveComment(cid) : unresolveComment(cid);
      if (updated) row = updated;
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

  // ─── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const settings = await getSettings();
      const envClaudeFlags = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
      res.json({
        ...settings,
        envOverrides: {
          claudeFlags: envClaudeFlags ? envClaudeFlags : null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/settings', async (req: Request, res: Response) => {
    try {
      const settings = await updateSettings(req.body);
      res.json(settings);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('Invalid editor') || message.startsWith('Invalid claudeFlags')) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // ─── Repo Config ────────────────────────────────────────────────────────────

  app.get('/api/repo-configs', async (_req: Request, res: Response) => {
    try {
      const configs = listRepoConfigs();
      res.json(configs);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/repo-config', async (req: Request, res: Response) => {
    const repoPath = req.query.repo_path as string;
    if (!repoPath) {
      res.status(400).json({ error: 'repo_path query parameter is required' });
      return;
    }
    try {
      const config = await getOrCreateRepoConfig(repoPath);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/repo-config', async (req: Request, res: Response) => {
    const { repo_path, ...updates } = req.body as Record<string, unknown>;
    if (!repo_path || typeof repo_path !== 'string') {
      res.status(400).json({ error: 'repo_path is required' });
      return;
    }
    try {
      const config = updateRepoConfig(repo_path, updates);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Agents ──────────────────────────────────────────────────────────────────

  app.get('/api/agents', async (_req: Request, res: Response) => {
    try {
      const agents = await listAgents();
      res.json(agents);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name', async (req: Request, res: Response) => {
    try {
      const agent = await getAgent(req.params.name as string);
      res.json(agent);
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  app.put('/api/agents/:name', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string };
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      await saveAgent(req.params.name as string, content);
      await syncAgents();
      const agent = await getAgent(req.params.name as string);
      res.json(agent);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agents/:name', async (req: Request, res: Response) => {
    try {
      const name = req.params.name as string;
      if (isBuiltInAgent(name)) {
        await resetAgent(name);
      } else {
        await deleteAgent(name);
      }
      await syncAgents();
      res.json({ ok: true });
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  app.post('/api/agents', async (req: Request, res: Response) => {
    const { name, content } = req.body as { name?: string; content?: string };
    if (!name || !content) {
      res.status(400).json({ error: 'name and content are required' });
      return;
    }
    try {
      await createAgent(name, content);
      await syncAgents();
      const agent = await getAgent(name);
      res.status(201).json(agent);
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  // ─── Chats (standalone runtime agents) ───────────────────────────────────
  // Distinct from /api/agents (agent-prompt definitions). A "chat" is a
  // tmux-backed Claude runtime instance with `agents.task_id = NULL`.

  app.get('/api/chats', (_req: Request, res: Response) => {
    try {
      res.json(listChats());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/chats/:id', (req: Request, res: Response) => {
    const chat = getChat(req.params.id as string);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json(chat);
  });

  /**
   * Move a runtime agent between task ids (or detach to a standalone chat
   * with task_id=null). Kills the old tmux window, opens a new one at the new
   * cwd, and resumes claude so transcript context survives.
   */
  app.patch('/api/agents/:id/task', async (req: Request, res: Response) => {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as
      | Agent
      | undefined;
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const body = (req.body ?? {}) as { task_id?: string | null };
    if (!('task_id' in body)) {
      res.status(400).json({ error: 'task_id is required (string or null)' });
      return;
    }
    const targetTaskId = body.task_id;
    if (targetTaskId !== null && typeof targetTaskId !== 'string') {
      res.status(400).json({ error: 'task_id must be a string or null' });
      return;
    }
    if (targetTaskId === agent.task_id) {
      res.status(400).json({ error: 'Agent is already on that task' });
      return;
    }
    if (targetTaskId !== null) {
      const targetTask = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(targetTaskId) as
        | Task
        | undefined;
      if (!targetTask) {
        res.status(404).json({ error: `Task not found: ${targetTaskId}` });
        return;
      }
      const trs = (targetTask as Task).runtime_state;
      if (!(['setting_up', 'running'] as const).includes(trs as 'running')) {
        res.status(409).json({ error: `Target task is not active (runtime_state=${trs})` });
        return;
      }
      if (!targetTask.worktree_id) {
        res.status(409).json({ error: 'Target task has no worktree' });
        return;
      }
    }

    try {
      const updated = await hopAgent(agent, targetTaskId);
      broadcast({ type: 'task:updated', payload: { taskId: agent.task_id ?? targetTaskId ?? '' } });
      res.json(updated);
    } catch (err) {
      const msg = (err as Error).message;
      apiLogger.error(
        {
          agent_id: agent.id,
          from_task_id: agent.task_id,
          to_task_id: targetTaskId,
          operation: 'task_hop',
          err,
        },
        'task_hop: failed',
      );
      if (msg.includes('not found') || msg.includes('does not exist')) {
        res.status(409).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/chats', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateChatRequest;
    try {
      const chat = await createChat({
        label: body.label,
        cwd: body.cwd,
        agent: body.agent,
        prompt: body.prompt,
      });
      res.status(201).json(chat);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Close a chat — stop the tmux session, mark the agent stopped.
   * Body: `{ status: 'stopped' }`. Preserves the row so history stays visible.
   */
  app.patch('/api/chats/:id', async (req: Request, res: Response) => {
    const chat = getChat(req.params.id as string);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    const body = (req.body ?? {}) as { status?: string };
    if (body.status !== 'stopped') {
      res.status(400).json({ error: "Only status='stopped' is supported" });
      return;
    }
    try {
      await closeChat(chat);
      const updated = getChat(chat.id);
      broadcast({ type: 'chat:updated', payload: { chatId: chat.id } });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Delete a chat — kill tmux, remove scratch dir, delete DB row. */
  app.delete('/api/chats/:id', async (req: Request, res: Response) => {
    const chat = getChat(req.params.id as string);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    try {
      await deleteChat(chat);
      broadcast({ type: 'chat:deleted', payload: { chatId: chat.id } });
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Worktrees (browser) ─────────────────────────────────────────────────

  app.get('/api/worktrees', (_req: Request, res: Response) => {
    const db = getDb();
    // The worktrees table holds one row per task lifecycle, but the same
    // physical workspace (same repo_path / mode / branch / path) may back
    // many tasks over time — most visibly in `none` mode where every task
    // points at the same repo checkout. Collapse those into a single row,
    // pick the freshest member as the row id (so detail navigation lands on
    // the active task), and aggregate task counts and recency. Rows that no
    // task references are leftover state and stay hidden — the workspaces
    // list mirrors actual user activity, not historical bookkeeping.
    const rows = db
      .prepare(
        `WITH grouped AS (
           SELECT w.id,
                  w.path,
                  w.repo_path,
                  w.branch,
                  w.base_branch,
                  w.base_sha,
                  w.mode,
                  w.status,
                  w.created_at,
                  w.last_used_at,
                  COALESCE(w.repo_path, '') || '|' ||
                  COALESCE(w.mode, '')      || '|' ||
                  COALESCE(w.branch, '')    || '|' ||
                  COALESCE(w.path, '')      AS group_key,
                  COALESCE(w.last_used_at, w.created_at) AS recency,
                  ROW_NUMBER() OVER (
                    PARTITION BY
                      COALESCE(w.repo_path, ''),
                      COALESCE(w.mode, ''),
                      COALESCE(w.branch, ''),
                      COALESCE(w.path, '')
                    ORDER BY COALESCE(w.last_used_at, w.created_at) DESC, w.id DESC
                  ) AS rn
             FROM worktrees w
            WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.worktree_id = w.id)
         ),
         agg AS (
           SELECT group_key,
                  COUNT(*) FILTER (WHERE 1=1) AS row_count,
                  SUM(
                    (SELECT COUNT(*) FROM tasks t WHERE t.worktree_id = grouped.id)
                  ) AS task_count,
                  MAX(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END) AS any_in_use,
                  MAX(recency) AS recency
             FROM grouped
            GROUP BY group_key
         )
         SELECT g.id,
                g.path,
                g.repo_path,
                g.branch,
                g.base_branch,
                g.base_sha,
                g.mode,
                CASE WHEN agg.any_in_use = 1 THEN 'in_use' ELSE 'available' END AS status,
                g.created_at,
                agg.recency AS last_used_at,
                agg.task_count AS task_count,
                (SELECT t.id FROM tasks t
                   INNER JOIN worktrees w2 ON w2.id = t.worktree_id
                  WHERE COALESCE(w2.repo_path,'') || '|' || COALESCE(w2.mode,'') || '|'
                     || COALESCE(w2.branch,'')   || '|' || COALESCE(w2.path,'')
                      = g.group_key
                    AND t.runtime_state IN ('idle','setting_up','running')
                  ORDER BY CASE t.runtime_state
                             WHEN 'running'    THEN 0
                             WHEN 'setting_up' THEN 1
                             ELSE 2
                           END, t.updated_at DESC
                  LIMIT 1) AS active_task_id
           FROM grouped g
           INNER JOIN agg ON agg.group_key = g.group_key
          WHERE g.rn = 1
          ORDER BY agg.recency DESC`,
      )
      .all() as WorktreeSummary[];
    res.json(rows);
  });

  app.get('/api/worktrees/:id', (req: Request, res: Response) => {
    const db = getDb();
    const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(req.params.id) as
      | Worktree
      | undefined;
    if (!worktree) {
      res.status(404).json({ error: 'Worktree not found' });
      return;
    }
    const tasks = db
      .prepare(`${SELECT_TASK_SQL} WHERE t.worktree_id = ? ORDER BY t.updated_at DESC`)
      .all(worktree.id) as Task[];
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
    const db = getDb();
    const worktree = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(req.params.id) as
      | Worktree
      | undefined;
    if (!worktree) {
      res.status(404).json({ error: 'Worktree not found' });
      return;
    }
    if (worktree.status !== 'available') {
      res.status(409).json({ error: 'Worktree is in use' });
      return;
    }
    const referencingTasks = db
      .prepare('SELECT id, runtime_state FROM tasks WHERE worktree_id = ?')
      .all(worktree.id) as Array<{ id: string; runtime_state: string }>;
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
    db.prepare('UPDATE tasks SET worktree_id = NULL WHERE worktree_id = ?').run(worktree.id);
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(worktree.id);
    apiLogger.info(
      { worktree_id: worktree.id, mode: worktree.mode, operation: 'delete_worktree' },
      'worktree deleted',
    );
    res.status(204).send();
  });

  // ─── Task Workflow Endpoints ──────────────────────────────────────────────────

  // B3: Bulk-archive all done tasks
  app.post('/api/tasks/archive-done', async (req: Request, res: Response) => {
    const db = getDb();
    const doneTasks = db
      .prepare(`${SELECT_TASK_SQL} WHERE t.workflow_status = 'done'`)
      .all() as Task[];

    let archivedCount = 0;
    for (const task of doneTasks) {
      // Close running tasks before archiving
      if (task.runtime_state === 'running' || task.runtime_state === 'setting_up') {
        await closeTask(task);
      }

      const updateId = nanoid(12);
      db.prepare(
        `UPDATE tasks SET workflow_status = 'archived', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);

      db.prepare(
        `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', 'done', 'archived', ?)`,
      ).run(updateId, task.id, 'auto: bulk archive');

      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      archivedCount++;
    }

    apiLogger.info({ operation: 'archive_done', archived: archivedCount }, 'bulk archive done');
    res.json({ archived: archivedCount });
  });

  // Move task to a new workflow_status
  app.post('/api/tasks/:id/move', async (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();
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

    // Auto-close runtime when moving to a terminal column (done or archived) if
    // the task is still actively running. Keeps the worktree/branch (close, not delete).
    if (
      (body.workflow_status === 'done' || body.workflow_status === 'archived') &&
      (task.runtime_state === 'running' || task.runtime_state === 'setting_up')
    ) {
      await closeTask(task);
    }

    const prevStatus = task.workflow_status;
    db.prepare(
      `UPDATE tasks SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(body.workflow_status, task.id);

    const updateId = nanoid(12);
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', ?, ?, ?)`,
    ).run(updateId, task.id, prevStatus, body.workflow_status, body.note ?? null);

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
      db.prepare(
        `UPDATE tasks SET runtime_state = 'setting_up', error = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
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
    const db = getDb();
    const body = req.body as SummaryRequest;

    if (!body.summary?.trim()) {
      res.status(400).json({ error: 'summary is required' });
      return;
    }

    db.prepare(
      `UPDATE tasks SET current_summary = ?, current_summary_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(body.summary, task.id);

    const updateId = nanoid(12);
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body) VALUES (?, ?, 'summary', ?)`,
    ).run(updateId, task.id, body.summary);

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
    const db = getDb();
    const body = req.body as NoteRequest;

    if (!body.body?.trim()) {
      res.status(400).json({ error: 'body is required' });
      return;
    }

    const updateId = nanoid(12);
    db.prepare(`INSERT INTO task_updates (id, task_id, kind, body) VALUES (?, ?, 'note', ?)`).run(
      updateId,
      task.id,
      body.body,
    );

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
    const db = getDb();
    const body = req.body as AddRefRequest;

    if (!body.integration?.trim()) {
      res.status(400).json({ error: 'integration is required' });
      return;
    }
    if (!body.ref?.trim()) {
      res.status(400).json({ error: 'ref is required' });
      return;
    }

    db.prepare(
      `INSERT OR REPLACE INTO task_external_refs (task_id, integration, ref, url, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(task.id, body.integration, body.ref, body.url ?? null);

    fireHook('ref_added', {
      event: 'ref_added',
      task,
      data: { integration: body.integration, ref: body.ref, url: body.url },
    });

    const row = db
      .prepare('SELECT * FROM task_external_refs WHERE task_id = ? AND integration = ?')
      .get(task.id, body.integration) as TaskExternalRef;
    res.status(201).json(row);
  });

  // Delete an external ref
  app.delete('/api/tasks/:id/refs/:integration', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();
    const integration = (req.params as Record<string, string>).integration;

    const existing = db
      .prepare('SELECT * FROM task_external_refs WHERE task_id = ? AND integration = ?')
      .get(task.id, integration) as TaskExternalRef | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Ref not found' });
      return;
    }

    db.prepare('DELETE FROM task_external_refs WHERE task_id = ? AND integration = ?').run(
      task.id,
      integration,
    );

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
    const db = getDb();
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 1000);

    const updates = db
      .prepare(`SELECT * FROM task_updates WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(task.id, limit) as TaskUpdate[];
    res.json(updates);
  });

  // Get task external refs
  app.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const db = getDb();
    const refs = db
      .prepare('SELECT * FROM task_external_refs WHERE task_id = ? ORDER BY created_at ASC')
      .all(task.id) as TaskExternalRef[];
    res.json(refs);
  });

  // ─── Hook executions for a task ──────────────────────────────────────────────
  app.get('/api/tasks/:id/hooks', (req: Request, res: Response) => {
    const task = loadTaskOrFail(req, res);
    if (!task) return;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const executions = getTaskHookExecutions(task.id, limit);
    res.json(executions);
  });

  // ─── Skills ──────────────────────────────────────────────────────────────────

  app.get('/api/skills', async (_req: Request, res: Response) => {
    try {
      const skills = await listSkills();
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/skills/:name', async (req: Request, res: Response) => {
    try {
      const skill = await getSkill(req.params.name as string);
      res.json(skill);
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  app.post('/api/skills', async (req: Request, res: Response) => {
    const { name, content } = req.body as { name?: string; content?: string };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    try {
      const skill = await createSkill(name, content || '');
      res.status(201).json(skill);
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  app.put('/api/skills/:name', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string };
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      const skill = await updateSkill(req.params.name as string, content);
      res.json(skill);
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  app.delete('/api/skills/:name', async (req: Request, res: Response) => {
    try {
      await deleteSkill(req.params.name as string);
      res.status(204).send();
    } catch (err) {
      sendDomainError(res, err);
    }
  });

  // ─── Integrations ─────────────────────────────────────────────────────────────

  // GET /api/integrations/providers — list registered providers with their schemas
  app.get('/api/integrations/providers', (_req: Request, res: Response) => {
    const providers = listProviders().map((p) => ({
      kind: p.kind,
      displayName: p.displayName,
      configSchema: p.configSchema,
      events: p.events,
    }));
    res.json(providers);
  });

  // GET /api/integrations — list all configured integrations (config masked)
  app.get('/api/integrations', (_req: Request, res: Response) => {
    const integrations = listIntegrations();
    const masked = integrations.map((i) => {
      const provider = getProvider(i.kind);
      if (!provider) return i;
      return maskIntegration(i, provider.configSchema);
    });
    res.json(masked);
  });

  // POST /api/integrations — create a new integration
  app.post('/api/integrations', (req: Request, res: Response) => {
    const body = req.body as { kind?: string; name?: string; config?: unknown };
    if (!body.kind?.trim()) {
      res.status(400).json({ error: 'kind is required' });
      return;
    }
    if (!body.name?.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const provider = getProvider(body.kind);
    if (!provider) {
      res.status(400).json({ error: `unknown integration kind: ${body.kind}` });
      return;
    }
    const validation = provider.validate(body.config ?? {});
    if (!validation.ok) {
      res.status(400).json({ error: 'config validation failed', details: validation.errors });
      return;
    }
    const integration = createIntegration(body.kind, body.name, body.config ?? {});
    res.status(201).json(maskIntegration(integration, provider.configSchema));
  });

  // PATCH /api/integrations/:id — update an integration
  app.patch('/api/integrations/:id', (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const existing = getIntegration(id);
    if (!existing) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const provider = getProvider(existing.kind);
    const body = req.body as { name?: string; config?: unknown; enabled?: boolean };
    const patch: { name?: string; config?: unknown; enabled?: boolean } = {};

    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    if (body.config !== undefined) {
      const mergedConfig = provider
        ? mergeMaskedConfig(existing.config, body.config, provider.configSchema)
        : (body.config as Record<string, unknown>);
      const validation = provider ? provider.validate(mergedConfig) : { ok: true };
      if (!validation.ok) {
        res.status(400).json({
          error: 'config validation failed',
          details: (validation as { errors?: string[] }).errors,
        });
        return;
      }
      patch.config = mergedConfig;
    }

    const updated = updateIntegration(id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    res.json(provider ? maskIntegration(updated, provider.configSchema) : updated);
  });

  // DELETE /api/integrations/:id
  app.delete('/api/integrations/:id', (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const existing = getIntegration(id);
    if (!existing) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    deleteIntegration(id);
    res.status(204).send();
  });

  // POST /api/integrations/:id/test — test the connection using stored (unmasked) config
  app.post('/api/integrations/:id/test', async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const existing = getIntegration(id);
    if (!existing) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }
    const provider = getProvider(existing.kind);
    if (!provider) {
      res.status(400).json({ error: `no provider for kind: ${existing.kind}` });
      return;
    }
    if (!provider.test) {
      res.json({ ok: true, message: 'Provider does not support connection testing' });
      return;
    }
    try {
      const result = await provider.test(existing.config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  // ─── C4: Hook registry endpoints ──────────────────────────────────────────

  const ALL_HOOK_EVENTS = [
    'workflow_status_changed',
    'summary_updated',
    'note_added',
    'ref_added',
    'ref_removed',
    'task_created',
    'runtime_state_changed',
  ] as const;

  const isProduction = process.env.NODE_ENV === 'production';
  const hooksLogsDir = isProduction
    ? path.join(os.homedir(), '.octomux', 'logs', 'hooks')
    : path.join(__dirname, '..', 'data', 'logs', 'hooks');

  interface HookRegistryEntry {
    scope: 'global' | `repo:${string}` | 'builtin';
    key: string;
    event: string | null;
    script_path: string | null;
    description: string | null;
    enabled: boolean;
    requires_env: string | null;
    last_run_at: string | null;
    last_exit_code: number | null;
  }

  /** Parse the most-recent log file for a given event+script-basename. */
  function findLastRunMeta(
    event: string,
    scriptName: string,
  ): { last_run_at: string | null; last_exit_code: number | null } {
    try {
      if (!fs.existsSync(hooksLogsDir)) return { last_run_at: null, last_exit_code: null };
      const prefix = `${event}-`;
      const suffix = `-${scriptName}`;
      const files = fs
        .readdirSync(hooksLogsDir)
        .filter(
          (f) => f.startsWith(prefix) && (f.endsWith(`${suffix}.log`) || f.includes(`${suffix}-`)),
        )
        .map((f) => {
          try {
            return { f, mtime: fs.statSync(path.join(hooksLogsDir, f)).mtimeMs };
          } catch {
            return { f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) return { last_run_at: null, last_exit_code: null };

      const logPath = path.join(hooksLogsDir, files[0].f);
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      const headerLine = lines.find((l) => l.startsWith('[octomux] event='));
      const footerLine = lines.slice(1).find((l) => l.startsWith('[octomux] duration_ms='));

      let last_run_at: string | null = null;
      let last_exit_code: number | null = null;

      if (headerLine) {
        const m = headerLine.match(/started_at=(\d+)/);
        if (m) last_run_at = new Date(parseInt(m[1], 10)).toISOString();
      }
      if (footerLine) {
        const ec = footerLine.match(/exit_code=(-?\d+)/);
        if (ec) last_exit_code = parseInt(ec[1], 10);
      }
      return { last_run_at, last_exit_code };
    } catch {
      return { last_run_at: null, last_exit_code: null };
    }
  }

  /** Read enabled state from hook_settings; missing row = defaultEnabled. */
  function getHookEnabled(scope: string, key: string, defaultEnabled: boolean): boolean {
    try {
      const row = getDb()
        .prepare(`SELECT enabled FROM hook_settings WHERE scope = ? AND key = ?`)
        .get(scope, key) as { enabled: number } | undefined;
      if (row === undefined) return defaultEnabled;
      return row.enabled !== 0;
    } catch {
      return defaultEnabled;
    }
  }

  /** Discover scripts for all events under a hooks base directory. */
  function discoverHookScripts(
    hooksBase: string,
    scope: HookRegistryEntry['scope'],
  ): HookRegistryEntry[] {
    const entries: HookRegistryEntry[] = [];
    for (const event of ALL_HOOK_EVENTS) {
      const dir = path.join(hooksBase, `${event}.d`);
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs
          .readdirSync(dir)
          .filter((name) => {
            try {
              return fs.statSync(path.join(dir, name)).isFile();
            } catch {
              return false;
            }
          })
          .sort();
        for (const name of files) {
          const key = `${event}/${name}`;
          const runMeta = findLastRunMeta(event, name);
          entries.push({
            scope,
            key,
            event,
            script_path: path.join(dir, name),
            description: null,
            enabled: getHookEnabled(scope, key, true),
            requires_env: null,
            last_run_at: runMeta.last_run_at,
            last_exit_code: runMeta.last_exit_code,
          });
        }
      } catch {
        // skip unreadable dirs
      }
    }
    return entries;
  }

  // GET /api/hooks/registry — list all hooks with enabled state
  app.get('/api/hooks/registry', (_req: Request, res: Response) => {
    const entries: HookRegistryEntry[] = [];

    // Built-in: summarize-progress (defaults disabled)
    const builtinEnabled = getHookEnabled('builtin', 'summarize-progress', false);
    entries.push({
      scope: 'builtin',
      key: 'summarize-progress',
      event: null,
      script_path: null,
      description:
        'After each agent stop, calls Haiku to write a one-sentence progress summary to tasks.current_summary.',
      enabled: builtinEnabled,
      requires_env: process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY',
      last_run_at: null,
      last_exit_code: null,
    });

    // Global hooks: ~/.octomux/hooks/
    const globalHooksBase = path.join(os.homedir(), '.octomux', 'hooks');
    entries.push(...discoverHookScripts(globalHooksBase, 'global'));

    // Repo hooks: collect from every active task's repo_path
    try {
      const activeTasks = getDb()
        .prepare(
          `SELECT DISTINCT w.repo_path
             FROM tasks t
             JOIN worktrees w ON w.id = t.worktree_id
            WHERE t.runtime_state IN ('running', 'setting_up')
              AND w.repo_path IS NOT NULL`,
        )
        .all() as Array<{ repo_path: string }>;

      const seen = new Set<string>();
      for (const { repo_path } of activeTasks) {
        if (seen.has(repo_path)) continue;
        seen.add(repo_path);
        const scope: HookRegistryEntry['scope'] = `repo:${repo_path}`;
        const repoHooksBase = path.join(repo_path, '.octomux', 'hooks');
        entries.push(...discoverHookScripts(repoHooksBase, scope));
      }
    } catch {
      // DB error — skip repo hooks
    }

    res.json({ hooks: entries });
  });

  // PATCH /api/hooks/registry/:scope/:key — toggle a hook
  app.patch('/api/hooks/registry/:scope/:key', (req: Request, res: Response) => {
    const params = req.params as Record<string, string>;
    const scope = decodeURIComponent(params.scope);
    const key = decodeURIComponent(params.key);
    const { enabled } = req.body as { enabled?: unknown };

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'body must contain { enabled: boolean }' });
      return;
    }

    try {
      getDb()
        .prepare(
          `INSERT INTO hook_settings (scope, key, enabled, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(scope, key) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = datetime('now')`,
        )
        .run(scope, key, enabled ? 1 : 0);

      // Invalidate dispatcher cache for this entry
      invalidateHookEnabledCache(scope, key);

      res.json({ scope, key, enabled });
    } catch (err) {
      apiLogger.warn({ scope, key, err }, 'failed to update hook_settings');
      res.status(500).json({ error: 'failed to update hook setting' });
    }
  });
}
