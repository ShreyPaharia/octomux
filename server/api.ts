import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from './db.js';
import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import { startTask, closeTask, addAgent, stopAgent } from './task-runner.js';
import { buildPRPrompt } from './pr-template.js';
import {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
} from './orchestrator.js';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Task,
  Agent,
} from './types.js';

const execFile = promisify(execFileCb);

/** Run claude CLI with prompt piped via stdin to avoid arg length issues. */
function runClaude(prompt: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p'], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `claude exited with code ${code}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export function setupRoutes(app: Express): void {
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
  app.get('/api/tasks', (_req: Request, res: Response) => {
    const db = getDb();
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
    const agentStmt = db.prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index');

    const result = tasks.map((task) => ({
      ...task,
      agents: agentStmt.all(task.id) as Agent[],
    }));

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
    task.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
    res.json(task);
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
      'INSERT INTO tasks (id, title, description, repo_path, initial_prompt) VALUES (?, ?, ?, ?, ?)',
    ).run(id, body.title, body.description, body.repo_path, body.initial_prompt ?? null);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    task.agents = [];

    // Start task immediately unless explicitly saved as draft
    if (!body.draft) {
      startTask(task);
    }

    res.status(201).json(task);
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

    if (body.status === 'closed') {
      await closeTask(task);
    }

    if (body.status) {
      db.prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
        body.status,
        task.id,
      );
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
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

    startTask(task);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
      .all(task.id) as Agent[];
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

    await closeTask(task);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
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

  // Preview PR (generate title + body via Claude)
  app.post('/api/tasks/:id/pr/preview', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (!task.branch) {
      res.status(400).json({ error: 'Task has no branch' });
      return;
    }

    try {
      // Detect base branch
      const base =
        req.body.base ||
        (await execFile('git', [
          '-C',
          task.repo_path,
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
        ]).then(
          ({ stdout }) => stdout.trim().replace('refs/remotes/origin/', ''),
          () => 'main',
        ));

      // Push the branch (non-fatal — may already be pushed or hooks may block)
      await execFile('git', ['-C', task.repo_path, 'push', '-u', 'origin', task.branch]).catch(
        () => {},
      );

      // Gather context
      const [logResult, diffResult] = await Promise.all([
        execFile('git', ['-C', task.repo_path, 'log', `${base}...${task.branch}`, '--oneline']),
        execFile('git', ['-C', task.repo_path, 'diff', `${base}...${task.branch}`, '--stat']),
      ]);

      if (!logResult.stdout.trim() && !diffResult.stdout.trim()) {
        throw new Error(
          `No commits found on branch ${task.branch} relative to ${base}. The agent may not have committed any changes.`,
        );
      }

      const prompt = buildPRPrompt({
        taskTitle: task.title,
        taskDescription: task.description,
        commitLog: logResult.stdout.trim(),
        diffStats: diffResult.stdout.trim(),
      });

      // Call claude CLI with prompt piped via stdin
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const claudeOutput = await runClaude(prompt, cleanEnv);

      // Parse JSON from claude output (may be wrapped in markdown or have extra text)
      const jsonMatch = claudeOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse Claude response as JSON');
      }
      const { title, body } = JSON.parse(jsonMatch[0]);

      res.json({ title, body, base });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create PR
  app.post('/api/tasks/:id/pr', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (!task.branch) {
      res.status(400).json({ error: 'Task has no branch' });
      return;
    }

    if (task.pr_url) {
      res.status(400).json({ error: 'Task already has a PR' });
      return;
    }

    const { base, title, body } = req.body;
    if (!base || !title || !body) {
      res.status(400).json({ error: 'base, title, and body are required' });
      return;
    }

    try {
      // Push the branch (may already be pushed from preview)
      await execFile('git', ['-C', task.repo_path, 'push', '-u', 'origin', task.branch]).catch(
        () => {},
      );

      // Create PR via gh CLI
      const { stdout } = await execFile(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          task.repo_path,
          '--head',
          task.branch,
          '--base',
          base,
          '--title',
          title,
          '--body',
          body,
        ],
        { cwd: task.repo_path },
      );

      // Parse PR URL from gh output
      const prUrl = stdout.trim();
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

      // Update DB
      db.prepare(
        `UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(prUrl, prNumber, task.id);

      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
      updated.agents = db
        .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
        .all(task.id) as Agent[];

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
