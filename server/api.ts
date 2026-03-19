import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from './db.js';
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

import {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
} from './orchestrator.js';
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
} from './types.js';

const execFile = promisify(execFileCb);

const TERMINALS_BY_TASK_SQL =
  'SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index';

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
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
  app.get('/api/browse', (req: Request, res: Response) => {
    const dirPath = (req.query.path as string) || os.homedir();

    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Path does not exist' });
      return;
    }

    const entries: Array<{ name: string; path: string; isGit: boolean }> = [];
    for (const name of fs.readdirSync(dirPath)) {
      const fullPath = path.join(dirPath, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
        const isGit = fs.existsSync(path.join(fullPath, '.git'));
        entries.push({ name, path: fullPath, isGit });
      } catch {
        // skip unreadable entries
      }
    }

    // Sort: git repos first, then hidden dirs last, then alphabetical
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
        `SELECT repo_path, MAX(created_at) as last_used FROM tasks GROUP BY repo_path ORDER BY last_used DESC LIMIT 10`,
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
        .prepare('SELECT * FROM tasks WHERE repo_path = ? ORDER BY created_at DESC')
        .all(repoPath) as Task[];
    } else {
      tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
    }

    const agentStmt = db.prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index');
    const promptStmt = db.prepare(
      `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id = ? AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
    );
    const userTerminalsStmt = db.prepare(TERMINALS_BY_TASK_SQL);

    const result = tasks.map((task) => {
      const agents = agentStmt.all(task.id) as Agent[];
      const pendingPrompts = promptStmt.all(task.id) as Array<Record<string, unknown>>;
      const parsedPrompts = pendingPrompts.map((pp) => ({
        ...pp,
        tool_input: safeParseJson(pp.tool_input as string),
      }));
      const userTerminals = userTerminalsStmt.all(task.id) as UserTerminal[];
      return {
        ...task,
        agents,
        pending_prompts: parsedPrompts,
        derived_status: derivedStatus({ status: task.status, agents }),
        user_terminals: userTerminals,
      };
    });

    res.json(result);
  });

  // Get single task with agents
  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
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
    res.json({
      ...task,
      agents,
      pending_prompts: parsedPrompts,
      derived_status: derivedStatus({ status: task.status, agents }),
      user_terminals: userTerminals,
    });
  });

  // Create task
  app.post('/api/tasks', async (req: Request, res: Response) => {
    const body = req.body as CreateTaskRequest;

    if (!body.title || !body.description || !body.repo_path) {
      res.status(400).json({ error: 'title, description, and repo_path are required' });
      return;
    }

    const db = getDb();

    const id = nanoid(12);
    db.prepare(
      'INSERT INTO tasks (id, title, description, repo_path, status, branch, base_branch, initial_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      body.title,
      body.description,
      body.repo_path,
      'draft',
      body.branch ?? null,
      body.base_branch ?? null,
      body.initial_prompt ?? null,
    );

    // Start task immediately unless explicitly saved as draft
    if (!body.draft) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
      await startTask(task);
    }

    const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    created.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(id) as Agent[];
    created.user_terminals = db.prepare(TERMINALS_BY_TASK_SQL).all(id) as UserTerminal[];
    broadcast({ type: 'task:created', payload: { taskId: id } });
    res.status(201).json(created);
  });

  // Update task status
  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    const body = req.body as UpdateTaskRequest;
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    // Draft field updates (title, description, repo_path, branch, base_branch, initial_prompt)
    const hasDraftFields = [
      'title',
      'description',
      'repo_path',
      'branch',
      'base_branch',
      'initial_prompt',
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

      const fields: string[] = [];
      const values: unknown[] = [];
      for (const key of [
        'title',
        'description',
        'repo_path',
        'branch',
        'base_branch',
        'initial_prompt',
      ] as const) {
        if (body[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(body[key] ?? null);
        }
      }
      if (fields.length > 0) {
        fields.push(`updated_at = datetime('now')`);
        values.push(task.id);
        db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
    } else if (body.status === 'running') {
      // Resume task
      if (task.status !== 'closed' && task.status !== 'error') {
        res.status(400).json({ error: 'Can only resume tasks in closed or error state' });
        return;
      }
      if (!task.worktree || !fs.existsSync(task.worktree)) {
        res.status(400).json({ error: 'Worktree no longer exists on disk' });
        return;
      }
      await resumeTask(task);
    } else if (body.status === 'closed') {
      await closeTask(task);
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
    updated.user_terminals = db.prepare(TERMINALS_BY_TASK_SQL).all(task.id) as UserTerminal[];
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json(updated);
  });

  // Start a draft task
  app.post('/api/tasks/:id/start', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (task.status !== 'draft') {
      res.status(400).json({ error: 'Only draft tasks can be started' });
      return;
    }

    await startTask(task);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
    updated.user_terminals = db.prepare(TERMINALS_BY_TASK_SQL).all(task.id) as UserTerminal[];
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json(updated);
  });

  // Delete task
  app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const taskId = task.id;
    await deleteTask(task);
    db.prepare('DELETE FROM agents WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    broadcast({ type: 'task:deleted', payload: { taskId } });
    res.status(204).send();
  });

  // Add agent to task
  app.post('/api/tasks/:id/agents', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

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
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;
    const agent = db
      .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
      .get(req.params.agentId, req.params.id) as Agent | undefined;

    if (!task || !agent) {
      res.status(404).json({ error: 'Task or agent not found' });
      return;
    }

    await stopAgent(task, agent);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json({ success: true });
  });

  // Create user terminal (lazily creates tmux window with nvim)
  app.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (task.status !== 'running') {
      res.status(400).json({ error: 'Can only create user terminal for running tasks' });
      return;
    }

    if (!task.tmux_session) {
      res.status(400).json({ error: 'Task has no tmux session' });
      return;
    }

    try {
      const userWindowIndex = await createUserTerminal(task);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      res.json({ user_window_index: userWindowIndex });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create shell terminal
  app.post('/api/tasks/:id/terminals', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
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
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const terminal = db
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
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (task.status !== 'running') {
      res.status(400).json({ error: 'Task is not running' });
      return;
    }

    const agent = db
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
}
