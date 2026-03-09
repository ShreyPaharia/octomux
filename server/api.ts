import type { Express, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { startTask, stopTask, addAgent, stopAgent } from './task-runner.js';
import type { CreateTaskRequest, UpdateTaskRequest, AddAgentRequest, Task, Agent } from './types.js';

export function setupRoutes(app: Express): void {
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
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    task.agents = db.prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index').all(task.id) as Agent[];
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
      'INSERT INTO tasks (id, title, description, repo_path) VALUES (?, ?, ?, ?)'
    ).run(id, body.title, body.description, body.repo_path);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    task.agents = [];

    // Start task asynchronously (worktree, tmux, claude)
    startTask(task);

    res.status(201).json(task);
  });

  // Update task status
  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    const body = req.body as UpdateTaskRequest;
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (body.status === 'done' || body.status === 'cancelled') {
      await stopTask(task);
    }

    if (body.status) {
      db.prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(body.status, task.id);
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    updated.agents = db.prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index').all(task.id) as Agent[];
    res.json(updated);
  });

  // Delete task
  app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    await stopTask(task);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    res.status(204).send();
  });

  // Add agent to task
  app.post('/api/tasks/:id/agents', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;

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
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
      .get(req.params.agentId, req.params.id) as Agent | undefined;

    if (!task || !agent) {
      res.status(404).json({ error: 'Task or agent not found' });
      return;
    }

    await stopAgent(task, agent);
    res.json({ success: true });
  });
}
