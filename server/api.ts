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
} from './task-runner.js';
import * as diffMod from './diff.js';
import { createChat, listChats, getChat } from './chats.js';
import { SELECT_TASK_SQL } from './task-select.js';

import {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
  sendToOrchestrator,
  typeToOrchestrator,
  getCustomPrompt,
  getDefaultPrompt,
  saveCustomPrompt,
  resetCustomPrompt,
} from './orchestrator.js';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from './skills.js';
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
} from './types.js';
import { RUN_MODES } from './types.js';

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
  status: string;
  agents: Array<{ status: string; hook_activity: string }>;
}): DerivedTaskStatus | null {
  if (task.status !== 'running') return null;
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
      tasks = db
        .prepare(`${SELECT_TASK_SQL} ORDER BY t.created_at DESC`)
        .all() as Task[];
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
        derived_status: derivedStatus({ status: task.status, agents }),
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
      ? (db.prepare('SELECT * FROM worktrees WHERE id = ?').get(task.worktree_id) as
          | Worktree
          | undefined) ?? null
      : null;
    res.json({
      ...task,
      agents,
      pending_prompts: parsedPrompts,
      derived_status: derivedStatus({ status: task.status, agents }),
      user_terminals: userTerminals,
      worktree_row: worktreeRow,
    });
  });

  // Create task
  app.post('/api/tasks', async (req: Request, res: Response) => {
    const body = req.body as CreateTaskRequest;
    const runMode: RunMode = body.run_mode ?? 'new';

    if (!body.title || !body.description) {
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
      if (body.base_branch || body.branch || body.worktree_path) {
        res.status(400).json({
          error: 'base_branch, branch, and worktree_path are not allowed for run_mode=none',
        });
        return;
      }
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

      db.prepare(
        `INSERT INTO tasks
           (id, title, description, status, initial_prompt, worktree_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        body.title,
        body.description,
        isDraft ? 'draft' : 'setting_up',
        body.initial_prompt ?? null,
        worktreeId,
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
      if (task.status !== 'draft') {
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
        db.prepare(
          `UPDATE worktrees SET ${worktreeFields.join(', ')} WHERE id = ?`,
        ).run(...worktreeValues);
      }
    } else if (body.status === 'running') {
      // Resume task
      if (task.status !== 'closed' && task.status !== 'error') {
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
    } else if (body.status === 'closed') {
      await closeTask(task);
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

    if (task.status !== 'draft') {
      res.status(400).json({ error: 'Only draft tasks can be started' });
      return;
    }

    // Set status immediately so client sees setting_up
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', updated_at = datetime('now') WHERE id = ?`,
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

    if (task.status !== 'running') {
      res.status(400).json({ error: 'Can only add agents to running tasks' });
      return;
    }

    const body = req.body as AddAgentRequest;
    const agent = await addAgent(task, body.prompt);
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

    if (task.status !== 'running') {
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

    if (task.status !== 'running') {
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

    if (task.status !== 'running') {
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
    try {
      const summary = await diffMod.getDiffSummary({ worktree: cwd, base: task.base_sha });
      res.json(summary);
    } catch (err) {
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
    try {
      const diff = await diffMod.getFileDiff({ worktree: cwd, base: task.base_sha, relPath });
      res.json(diff);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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

  // ─── Orchestrator ──────────────────────────────────────────────────────────

  app.get('/api/orchestrator/status', async (_req: Request, res: Response) => {
    const running = await isOrchestratorRunning();
    res.json({ running, session: getOrchestratorSession() });
  });

  app.post('/api/orchestrator/start', async (req: Request, res: Response) => {
    const cwd = (req.body as { cwd?: string })?.cwd;
    await startOrchestrator(cwd);
    res.json({ running: true, session: getOrchestratorSession() });
  });

  app.post('/api/orchestrator/stop', async (_req: Request, res: Response) => {
    await stopOrchestrator();
    res.json({ running: false });
  });

  app.post('/api/orchestrator/send', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const running = await isOrchestratorRunning();
      if (!running) {
        await startOrchestrator(undefined, message);
      } else {
        await sendToOrchestrator(message);
      }
      res.json({ ok: true, running: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Type message into orchestrator terminal without pressing Enter (user reviews first)
  app.post('/api/orchestrator/type', async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const running = await isOrchestratorRunning();
      if (!running) {
        await startOrchestrator();
      }
      await typeToOrchestrator(message);
      res.json({ ok: true, running: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ─── Orchestrator Prompt ────────────────────────────────────────────────────

  app.get('/api/orchestrator/prompt', async (_req: Request, res: Response) => {
    try {
      const [custom, defaultPrompt] = await Promise.all([getCustomPrompt(), getDefaultPrompt()]);
      res.json({
        content: custom ?? defaultPrompt,
        default: defaultPrompt,
        isCustom: custom !== null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/orchestrator/prompt', async (req: Request, res: Response) => {
    const { content } = req.body as { content?: string };
    if (content === undefined || content === null) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      await saveCustomPrompt(content);
      if (await isOrchestratorRunning()) {
        await stopOrchestrator();
        await startOrchestrator();
      }
      res.json({ ok: true, isCustom: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/orchestrator/prompt', async (_req: Request, res: Response) => {
    try {
      await resetCustomPrompt();
      if (await isOrchestratorRunning()) {
        await stopOrchestrator();
        await startOrchestrator();
      }
      res.json({ ok: true, isCustom: false });
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
      if (req.params.name === 'orchestrator' && (await isOrchestratorRunning())) {
        await stopOrchestrator();
        await startOrchestrator();
      }
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
      if (name === 'orchestrator' && (await isOrchestratorRunning())) {
        await stopOrchestrator();
        await startOrchestrator();
      }
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

  app.post('/api/chats', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateChatRequest;
    try {
      const chat = await createChat({ label: body.label, cwd: body.cwd });
      res.status(201).json(chat);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Worktrees (read-only index) ─────────────────────────────────────────

  app.get('/api/worktrees', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT w.*,
                (SELECT COUNT(*) FROM tasks t WHERE t.worktree_id = w.id) as task_count,
                (SELECT t.id FROM tasks t
                   WHERE t.worktree_id = w.id
                     AND t.status IN ('draft','setting_up','running')
                   LIMIT 1) as active_task_id
           FROM worktrees w
          ORDER BY COALESCE(w.last_used_at, w.created_at) DESC`,
      )
      .all() as WorktreeSummary[];
    res.json(rows);
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
}
