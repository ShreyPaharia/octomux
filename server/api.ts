import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    const entries: Array<{ name: string; path: string; isGit: boolean }> = [];

    for (const name of dirEntries) {
      const fullPath = path.join(dirPath, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isDirectory()) continue;
        let isGit = false;
        try {
          await fs.promises.access(path.join(fullPath, '.git'));
          isGit = true;
        } catch {
          // not a git repo
        }
        entries.push({ name, path: fullPath, isGit });
      } catch {
        // skip unreadable entries
      }
    }

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
    const isDraft = !!body.draft;

    db.prepare(
      'INSERT INTO tasks (id, title, description, repo_path, status, branch, base_branch, initial_prompt, no_worktree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      body.title,
      body.description,
      body.repo_path,
      isDraft ? 'draft' : 'setting_up',
      body.branch ?? null,
      body.base_branch ?? null,
      body.initial_prompt ?? null,
      body.no_worktree ? 1 : 0,
    );

    const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
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
      'no_worktree',
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
        'no_worktree',
      ] as const) {
        if (body[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(key === 'no_worktree' ? (body[key] ? 1 : 0) : (body[key] ?? null));
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
      if (!task.no_worktree && (!task.worktree || !fs.existsSync(task.worktree))) {
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

    // Set status immediately so client sees setting_up
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
    updated.user_terminals = db.prepare(TERMINALS_BY_TASK_SQL).all(task.id) as UserTerminal[];
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
      const result = await createUserTerminal(task);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      res.json(result);
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

  // ─── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const settings = await getSettings();
      res.json(settings);
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
      if (message.startsWith('Invalid editor')) {
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
      const status = (err as Error).message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
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
      if (name === 'orchestrator' && (await isOrchestratorRunning())) {
        await stopOrchestrator();
        await startOrchestrator();
      }
      res.json({ ok: true });
    } catch (err) {
      const status = (err as Error).message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: (err as Error).message });
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
      const agent = await getAgent(name);
      res.status(201).json(agent);
    } catch (err) {
      const status = (err as Error).message.includes('already exists') ? 409 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
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
      const e = err as NodeJS.ErrnoException;
      if (
        e.code === 'ENOENT' ||
        e.message.includes('not found') ||
        e.message.includes('does not exist')
      ) {
        res.status(404).json({ error: e.message });
      } else if (e.message.includes('Invalid skill name')) {
        res.status(400).json({ error: e.message });
      } else {
        res.status(500).json({ error: e.message });
      }
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
      const e = err as NodeJS.ErrnoException;
      if (e.message.includes('already exists')) {
        res.status(409).json({ error: e.message });
      } else if (e.message.includes('Invalid skill name')) {
        res.status(400).json({ error: e.message });
      } else {
        res.status(500).json({ error: e.message });
      }
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
      const e = err as NodeJS.ErrnoException;
      if (
        e.code === 'ENOENT' ||
        e.message.includes('not found') ||
        e.message.includes('does not exist')
      ) {
        res.status(404).json({ error: e.message });
      } else if (e.message.includes('Invalid skill name')) {
        res.status(400).json({ error: e.message });
      } else {
        res.status(500).json({ error: e.message });
      }
    }
  });

  app.delete('/api/skills/:name', async (req: Request, res: Response) => {
    try {
      await deleteSkill(req.params.name as string);
      res.status(204).send();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (
        e.code === 'ENOENT' ||
        e.message.includes('not found') ||
        e.message.includes('does not exist')
      ) {
        res.status(404).json({ error: e.message });
      } else if (e.message.includes('Invalid skill name')) {
        res.status(400).json({ error: e.message });
      } else {
        res.status(500).json({ error: e.message });
      }
    }
  });
}
