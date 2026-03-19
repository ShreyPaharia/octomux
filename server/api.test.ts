import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  getTask,
  DEFAULTS,
} from './test-helpers.js';
import type { Task, Agent } from './types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-runner.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    startTask: vi.fn(async (task: any) => {
      const db = getDb();
      const branch = task.branch || `agents/${task.id}`;
      db.prepare(
        `UPDATE tasks SET status = 'running', tmux_session = ?, branch = COALESCE(branch, ?), worktree = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(`octomux-agent-${task.id}`, branch, `/tmp/.worktrees/${task.id}`, task.id);
    }),
    closeTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare('UPDATE agents SET status = ? WHERE task_id = ?').run('stopped', task.id);
    }),
    deleteTask: vi.fn(),
    resumeTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(
        "UPDATE agents SET status = 'running' WHERE task_id = ? AND status = 'stopped'",
      ).run(task.id);
    }),
    addAgent: vi.fn(async (_task: any, _prompt?: string) => ({
      id: 'new-agent-id',
      task_id: _task.id,
      window_index: 1,
      label: 'Agent 2',
      status: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    })),
    stopAgent: vi.fn(),
    createUserTerminal: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET user_window_index = 5, updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      return 5;
    }),
  };
});

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readdirSync: vi.fn(() => []),
    existsSync: vi.fn(() => false),
  },
}));

vi.mock('./orchestrator.js', () => ({
  isOrchestratorRunning: vi.fn(async () => true),
  startOrchestrator: vi.fn(),
  stopOrchestrator: vi.fn(),
  getOrchestratorSession: vi.fn(() => 'octomux-orchestrator'),
  sendToOrchestrator: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], ..._rest: any[]) => {
    const cb = _rest.find((a: any) => typeof a === 'function');
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined;
  }),
}));

const fs = (await import('fs')).default;

const { createApp } = await import('./app.js');
const { startTask, closeTask, deleteTask, resumeTask, addAgent, stopAgent, createUserTerminal } =
  await import('./task-runner.js');
const { isOrchestratorRunning, startOrchestrator, sendToOrchestrator } =
  await import('./orchestrator.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.restoreAllMocks();
  db = createTestDb();
  app = createApp();
});

afterEach(() => {
  db.close();
});

// ─── 404 for nonexistent resources (table-driven) ────────────────────────────

const notFoundCases = [
  { name: 'GET /api/tasks/:id', method: 'get' as const, url: '/api/tasks/nonexistent' },
  {
    name: 'PATCH /api/tasks/:id',
    method: 'patch' as const,
    url: '/api/tasks/nonexistent',
    body: { status: 'closed' },
  },
  { name: 'DELETE /api/tasks/:id', method: 'delete' as const, url: '/api/tasks/nonexistent' },
  {
    name: 'POST /api/tasks/:id/start',
    method: 'post' as const,
    url: '/api/tasks/nonexistent/start',
  },
  {
    name: 'POST /api/tasks/:id/agents',
    method: 'post' as const,
    url: '/api/tasks/nonexistent/agents',
    body: {},
  },
  {
    name: 'DELETE /api/tasks/:id/agents/:agentId',
    method: 'delete' as const,
    url: '/api/tasks/nonexistent/agents/agent1',
  },

  {
    name: 'POST /api/tasks/:id/user-terminal',
    method: 'post' as const,
    url: '/api/tasks/nonexistent/user-terminal',
  },
  {
    name: 'POST /api/tasks/:id/agents/:agentId/message',
    method: 'post' as const,
    url: '/api/tasks/nonexistent/agents/agent1/message',
    body: { message: 'hello' },
  },
];

describe('404 for nonexistent resources', () => {
  it.each(notFoundCases)('$name → 404', async ({ method, url, body }) => {
    const res = body ? await request(app)[method](url).send(body) : await request(app)[method](url);
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/tasks ───────────────────────────────────────────────────────────

describe('GET /api/tasks', () => {
  it('returns empty array when no tasks exist', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns tasks with nested agents', async () => {
    insertTask(db);
    insertAgent(db);

    const res = await request(app).get('/api/tasks');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(DEFAULTS.task.id);
    expect(res.body[0].agents).toHaveLength(1);
    expect(res.body[0].agents[0].label).toBe(DEFAULTS.agent.label);
  });

  it('orders by created_at DESC', async () => {
    insertTask(db, { id: 'old', created_at: '2026-01-01 00:00:00' });
    insertTask(db, { id: 'new', created_at: '2026-02-01 00:00:00' });

    const res = await request(app).get('/api/tasks');
    expect(res.body.map((t: Task) => t.id)).toEqual(['new', 'old']);
  });

  it('returns empty agents array for tasks without agents', async () => {
    insertTask(db);
    const res = await request(app).get('/api/tasks');
    expect(res.body[0].agents).toEqual([]);
  });

  it('filters tasks by repo_path query param', async () => {
    insertTask(db, { id: 'task-a', repo_path: '/repo/alpha' });
    insertTask(db, { id: 'task-b', repo_path: '/repo/beta' });
    insertTask(db, { id: 'task-c', repo_path: '/repo/alpha' });

    const res = await request(app).get('/api/tasks?repo_path=/repo/alpha');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((t: Task) => t.repo_path === '/repo/alpha')).toBe(true);
  });

  it('returns all tasks when repo_path is not provided', async () => {
    insertTask(db, { id: 'task-a', repo_path: '/repo/alpha' });
    insertTask(db, { id: 'task-b', repo_path: '/repo/beta' });

    const res = await request(app).get('/api/tasks');
    expect(res.body).toHaveLength(2);
  });

  it('returns empty array when repo_path matches no tasks', async () => {
    insertTask(db, { id: 'task-a', repo_path: '/repo/alpha' });

    const res = await request(app).get('/api/tasks?repo_path=/repo/nonexistent');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── GET /api/tasks/:id ──────────────────────────────────────────────────────

describe('GET /api/tasks/:id', () => {
  it('returns task with agents', async () => {
    insertTask(db);
    insertAgent(db);

    const res = await request(app).get(`/api/tasks/${DEFAULTS.task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe(DEFAULTS.task.title);
    expect(res.body.agents).toHaveLength(1);
  });

  it('returns all task fields', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_url: 'https://github.com/org/repo/pull/42',
      pr_number: 42,
    });

    const res = await request(app).get(`/api/tasks/${DEFAULTS.task.id}`);
    expect(res.body.pr_url).toBe('https://github.com/org/repo/pull/42');
    expect(res.body.pr_number).toBe(42);
    expect(res.body.branch).toBe(DEFAULTS.runningTask.branch);
    expect(res.body.tmux_session).toBe(DEFAULTS.runningTask.tmux_session);
  });
});

// ─── POST /api/tasks ─────────────────────────────────────────────────────────

describe('POST /api/tasks', () => {
  const validPayload = {
    title: DEFAULTS.task.title,
    description: DEFAULTS.task.description,
    repo_path: DEFAULTS.task.repo_path,
  };

  it('creates task and returns 201', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe(validPayload.title);
    expect(res.body.description).toBe(validPayload.description);
    expect(res.body.repo_path).toBe(validPayload.repo_path);
    expect(res.body.status).toBe('running');
  });

  it('generates 12-char nanoid', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);
    expect(res.body.id).toHaveLength(12);
  });

  it('persists to database', async () => {
    await request(app).post('/api/tasks').send(validPayload);
    const tasks = db.prepare('SELECT * FROM tasks').all() as Task[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe(validPayload.title);
  });

  // ─── Validation (table-driven) ─────────────────────────────────────────

  const missingFieldCases = [
    { name: 'title missing', body: { description: 'D', repo_path: '/tmp' } },
    { name: 'description missing', body: { title: 'T', repo_path: '/tmp' } },
    { name: 'repo_path missing', body: { title: 'T', description: 'D' } },
    { name: 'empty body', body: {} },
    { name: 'title empty string', body: { title: '', description: 'D', repo_path: '/tmp' } },
  ];

  it.each(missingFieldCases)('returns 400 when $name', async ({ body }) => {
    const res = await request(app).post('/api/tasks').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });

  it('does not call startTask on validation failure', async () => {
    await request(app).post('/api/tasks').send({});
    expect(startTask).not.toHaveBeenCalled();
  });

  it('does not call startTask when draft=true', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, draft: true });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('calls startTask when draft is not set', async () => {
    await request(app).post('/api/tasks').send(validPayload);
    expect(startTask).toHaveBeenCalledOnce();
  });

  it('stores branch and base_branch when provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, branch: 'feat/my-feature', base_branch: 'develop' });

    expect(res.status).toBe(201);
    expect(res.body.branch).toBe('feat/my-feature');
    expect(res.body.base_branch).toBe('develop');

    const task = getTask(db, res.body.id);
    expect(task?.branch).toBe('feat/my-feature');
    expect(task?.base_branch).toBe('develop');
  });

  it('auto-generates branch when not provided', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);

    // Branch is auto-generated by startTask
    expect(res.body.branch).toContain('agents/');
    expect(res.body.base_branch).toBeNull();
  });

  it('stores initial_prompt when provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, initial_prompt: 'Fix the bug in orders.ts' });

    expect(res.status).toBe(201);
    const task = getTask(db, res.body.id);
    expect(task?.initial_prompt).toBe('Fix the bug in orders.ts');
  });
});

// ─── POST /api/tasks/:id/start ──────────────────────────────────────────────

describe('POST /api/tasks/:id/start', () => {
  it('starts a draft task', async () => {
    insertTask(db);

    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/start`);
    expect(res.status).toBe(200);
    expect(startTask).toHaveBeenCalledOnce();
    expect(vi.mocked(startTask).mock.calls[0][0].id).toBe(DEFAULTS.task.id);
  });

  const nonDraftStatuses = ['setting_up', 'running', 'closed', 'error'];

  it.each(nonDraftStatuses)('returns 400 when task status is %s', async (status) => {
    insertTask(db, { status: status as any });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/start`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('draft');
  });
});

// ─── PATCH /api/tasks/:id ────────────────────────────────────────────────────

describe('PATCH /api/tasks/:id', () => {
  it('updates status and returns updated task with agents', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.agents).toHaveLength(1);
  });

  it('updates updated_at timestamp', async () => {
    insertTask(db, { updated_at: '2020-01-01 00:00:00' });

    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'closed' });

    expect(res.body.updated_at).not.toBe('2020-01-01 00:00:00');
  });

  // ─── closeTask trigger ─────────────────────────────────────────────────

  it('calls closeTask when status=closed', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await request(app).patch(`/api/tasks/${DEFAULTS.task.id}`).send({ status: 'closed' });
    expect(closeTask).toHaveBeenCalledOnce();
  });

  it('does not call closeTask for non-terminal status changes', async () => {
    insertTask(db);
    await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' } as any);
    expect(closeTask).not.toHaveBeenCalled();
  });

  it('handles PATCH with empty body gracefully', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).patch(`/api/tasks/${DEFAULTS.task.id}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running'); // unchanged
    expect(closeTask).not.toHaveBeenCalled();
  });

  // ─── Resume flow (status=running) ─────────────────────────────────────

  it('returns 400 when resuming a non-closed/non-error task', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('resume');
  });

  const resumableStatuses = ['closed', 'error'] as const;

  it.each(resumableStatuses)('returns 400 when worktree missing for %s task', async (status) => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    insertTask(db, { ...DEFAULTS.runningTask, status });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Worktree');
  });

  it.each(resumableStatuses)('calls resumeTask for %s task with valid worktree', async (status) => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    insertTask(db, { ...DEFAULTS.runningTask, status });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(200);
    expect(resumeTask).toHaveBeenCalledOnce();
  });

  // ─── Draft field updates ──────────────────────────────────────────────────

  it('updates draft task fields', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    insertTask(db); // default status is 'draft'
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ title: 'Updated title', description: 'Updated desc', repo_path: '/tmp/other-repo' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated title');
    expect(res.body.description).toBe('Updated desc');
    expect(res.body.repo_path).toBe('/tmp/other-repo');
  });

  it('rejects field updates on non-draft tasks', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ title: 'New title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('draft');
  });

  it('rejects empty title on draft update', async () => {
    insertTask(db);
    const res = await request(app).patch(`/api/tasks/${DEFAULTS.task.id}`).send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title');
  });

  it('rejects empty description on draft update', async () => {
    insertTask(db);
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ description: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('description');
  });

  it('rejects non-existent repo_path on draft update', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    insertTask(db);
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ repo_path: '/nonexistent/path' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repo_path');
  });

  it('updates updated_at on draft field change', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    insertTask(db, { updated_at: '2020-01-01 00:00:00' });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ title: 'New title' });
    expect(res.body.updated_at).not.toBe('2020-01-01 00:00:00');
  });
});

// ─── DELETE /api/tasks/:id ───────────────────────────────────────────────────

describe('DELETE /api/tasks/:id', () => {
  it('deletes task and returns 204', async () => {
    insertTask(db);
    const res = await request(app).delete(`/api/tasks/${DEFAULTS.task.id}`);
    expect(res.status).toBe(204);
    expect(getTask(db, DEFAULTS.task.id)).toBeUndefined();
  });

  it('calls deleteTask before deleting', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await request(app).delete(`/api/tasks/${DEFAULTS.task.id}`);
    expect(deleteTask).toHaveBeenCalledOnce();
  });

  it('cascades delete to agents', async () => {
    insertTask(db);
    insertAgent(db);
    await request(app).delete(`/api/tasks/${DEFAULTS.task.id}`);
    expect(db.prepare('SELECT * FROM agents WHERE task_id = ?').all(DEFAULTS.task.id)).toHaveLength(
      0,
    );
  });
});

// ─── POST /api/tasks/:id/agents ──────────────────────────────────────────────

describe('POST /api/tasks/:id/agents', () => {
  // ─── Status gating (table-driven) ──────────────────────────────────────

  const nonRunningStatuses = ['draft', 'setting_up', 'closed', 'error'];

  it.each(nonRunningStatuses)('returns 400 when task status is %s', async (status) => {
    insertTask(db, { status: status as any });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/agents`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('running');
  });

  it('creates agent for running task', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents`)
      .send({ prompt: 'Write tests' });

    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Agent 2');
    expect(addAgent).toHaveBeenCalledOnce();
  });

  it('passes prompt to addAgent', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents`)
      .send({ prompt: 'Write comprehensive tests' });

    expect(vi.mocked(addAgent).mock.calls[0][1]).toBe('Write comprehensive tests');
  });

  it('works without prompt', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/agents`).send({});
    expect(res.status).toBe(201);
    expect(vi.mocked(addAgent).mock.calls[0][1]).toBeUndefined();
  });
});

// ─── DELETE /api/tasks/:id/agents/:agentId ───────────────────────────────────

describe('DELETE /api/tasks/:id/agents/:agentId', () => {
  it('returns 404 for nonexistent agent on existing task', async () => {
    insertTask(db);
    const res = await request(app).delete(`/api/tasks/${DEFAULTS.task.id}/agents/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when agent belongs to different task', async () => {
    insertTask(db, { id: 'task-a' });
    insertTask(db, { id: 'task-b' });
    insertAgent(db, { id: 'agent-on-b', task_id: 'task-b' });

    const res = await request(app).delete('/api/tasks/task-a/agents/agent-on-b');
    expect(res.status).toBe(404);
  });

  it('stops agent and returns success', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const res = await request(app).delete(
      `/api/tasks/${DEFAULTS.task.id}/agents/${DEFAULTS.agent.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(stopAgent).toHaveBeenCalledOnce();
  });
});

// ─── GET /api/browse ─────────────────────────────────────────────────────────

describe('GET /api/browse', () => {
  it('returns directory entries for valid path', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(fs.readdirSync).mockReturnValue(['project-a', 'project-b'] as any);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p).includes('project-a/.git'));

    const res = await request(app).get('/api/browse?path=/home/user');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('/home/user');
    expect(res.body.entries).toHaveLength(2);
    // Git repos sorted first
    expect(res.body.entries[0].name).toBe('project-a');
    expect(res.body.entries[0].isGit).toBe(true);
    expect(res.body.entries[1].name).toBe('project-b');
    expect(res.body.entries[1].isGit).toBe(false);
  });

  it('returns parent directory', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    const res = await request(app).get('/api/browse?path=/home/user');
    expect(res.body.parent).toBe('/home');
  });

  it('returns null parent for root directory', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    const res = await request(app).get('/api/browse?path=/');
    expect(res.body.parent).toBeNull();
  });

  it('returns 400 when path is not a directory', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

    const res = await request(app).get('/api/browse?path=/tmp/file.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not a directory');
  });

  it('returns 400 when path does not exist', async () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const res = await request(app).get('/api/browse?path=/nonexistent');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not exist');
  });

  it('skips non-directory entries', async () => {
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr === '/tmp') return { isDirectory: () => true } as any;
      if (pathStr.includes('file.txt')) return { isDirectory: () => false } as any;
      return { isDirectory: () => true } as any;
    });
    vi.mocked(fs.readdirSync).mockReturnValue(['dir1', 'file.txt'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const res = await request(app).get('/api/browse?path=/tmp');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].name).toBe('dir1');
  });

  it('sorts hidden directories after non-hidden', async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
    vi.mocked(fs.readdirSync).mockReturnValue(['.hidden', 'visible'] as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const res = await request(app).get('/api/browse?path=/tmp');
    expect(res.body.entries[0].name).toBe('visible');
    expect(res.body.entries[1].name).toBe('.hidden');
  });
});

// ─── GET /api/branches ──────────────────────────────────────────────────────

describe('GET /api/branches', () => {
  it('returns 400 when repo_path is missing', async () => {
    const res = await request(app).get('/api/branches');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repo_path');
  });

  it('returns deduplicated branch list', async () => {
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (cmd === 'git' && args.includes('branch')) {
        cb(null, { stdout: 'main\ndevelop\norigin/main\norigin/feature\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app).get('/api/branches?repo_path=/tmp/repo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['main', 'develop', 'feature']);
  });

  it('filters out HEAD from branch list', async () => {
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (cmd === 'git' && args.includes('branch')) {
        cb(null, { stdout: 'main\norigin/HEAD\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app).get('/api/branches?repo_path=/tmp/repo');
    expect(res.body).not.toContain('HEAD');
  });

  it('returns 400 when git command fails', async () => {
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((_cmd: string, _args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      cb(new Error('not a git repo'), null);
      return undefined as any;
    }) as any);

    const res = await request(app).get('/api/branches?repo_path=/tmp/not-a-repo');
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/default-branch ────────────────────────────────────────────────

describe('GET /api/default-branch', () => {
  it('returns 400 when repo_path is missing', async () => {
    const res = await request(app).get('/api/default-branch');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repo_path');
  });

  it('returns the default branch from symbolic-ref', async () => {
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (cmd === 'git' && args.includes('symbolic-ref')) {
        cb(null, { stdout: 'refs/remotes/origin/develop\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app).get('/api/default-branch?repo_path=/tmp/repo');
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('develop');
  });

  it('falls back to main when symbolic-ref fails', async () => {
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((_cmd: string, _args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      cb(new Error('fatal: ref not found'), null);
      return undefined as any;
    }) as any);

    const res = await request(app).get('/api/default-branch?repo_path=/tmp/repo');
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('main');
  });
});

// ─── GET /api/recent-repos ───────────────────────────────────────────────────

describe('GET /api/recent-repos', () => {
  it('returns empty array when no tasks exist', async () => {
    const res = await request(app).get('/api/recent-repos');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns unique repo paths ordered by most recent', async () => {
    insertTask(db, { id: 'task-1', repo_path: '/repo/a', created_at: '2026-01-01 00:00:00' });
    insertTask(db, { id: 'task-2', repo_path: '/repo/b', created_at: '2026-02-01 00:00:00' });
    insertTask(db, { id: 'task-3', repo_path: '/repo/a', created_at: '2026-03-01 00:00:00' });

    const res = await request(app).get('/api/recent-repos');
    expect(res.body).toHaveLength(2);
    expect(res.body[0].repo_path).toBe('/repo/a');
    expect(res.body[1].repo_path).toBe('/repo/b');
  });

  it('limits to 10 results', async () => {
    for (let i = 0; i < 12; i++) {
      insertTask(db, { id: `task-${i}`, repo_path: `/repo/${i}` });
    }

    const res = await request(app).get('/api/recent-repos');
    expect(res.body).toHaveLength(10);
  });
});

// ─── POST /api/tasks/:id/user-terminal ──────────────────────────────────────

describe('POST /api/tasks/:id/user-terminal', () => {
  it('creates user terminal and returns window index', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);

    expect(res.status).toBe(200);
    expect(res.body.user_window_index).toBe(5);
    expect(createUserTerminal).toHaveBeenCalledOnce();
  });

  it('returns 404 for nonexistent task', async () => {
    const res = await request(app).post('/api/tasks/nonexistent/user-terminal');
    expect(res.status).toBe(404);
  });

  it('returns 400 when task has no tmux session', async () => {
    insertTask(db, { tmux_session: null, status: 'running' });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tmux');
  });

  const nonRunningStatuses = ['draft', 'setting_up', 'closed', 'error'] as const;

  it.each(nonRunningStatuses)('returns 400 when task status is %s', async (status) => {
    insertTask(db, { ...DEFAULTS.runningTask, status });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/tasks with permission prompts ─────────────────────────────────

describe('GET /api/tasks with permission prompts', () => {
  it('includes pending_prompts in task response', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-1' });
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: 'a1',
      tool_name: 'Bash',
      tool_input: '{"command":"npm test"}',
    });

    const res = await request(app).get('/api/tasks').expect(200);
    const task = res.body[0];
    expect(task.pending_prompts).toHaveLength(1);
    expect(task.pending_prompts[0].tool_name).toBe('Bash');
    expect(task.pending_prompts[0].tool_input).toEqual({ command: 'npm test' });
    expect(task.pending_prompts[0].agent_label).toBe('Agent 1');
  });

  it('does not include resolved prompts', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1' });
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: 'a1',
      status: 'resolved' as any,
    });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].pending_prompts).toHaveLength(0);
  });

  it.each([
    { activities: ['active'], expected: 'working' },
    { activities: ['waiting'], expected: 'needs_attention' },
    { activities: ['idle'], expected: 'done' },
    { activities: ['active', 'waiting'], expected: 'working' },
    { activities: ['idle', 'idle'], expected: 'done' },
    { activities: ['idle', 'waiting'], expected: 'needs_attention' },
    { activities: ['active', 'idle'], expected: 'working' },
  ])(
    'derived_status is $expected when activities are $activities',
    async ({ activities, expected }) => {
      insertTask(db, { id: 't1', status: 'running' });
      activities.forEach((activity, i) => {
        insertAgent(db, {
          id: `a${i}`,
          task_id: 't1',
          window_index: i,
          hook_activity: activity as Agent['hook_activity'],
        });
      });

      const res = await request(app).get('/api/tasks').expect(200);
      expect(res.body[0].derived_status).toBe(expected);
    },
  );

  it('derived_status is done when all agents are stopped', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'idle' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBe('done');
  });

  it('derived_status is done when task has no agents', async () => {
    insertTask(db, { id: 't1', status: 'running' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBe('done');
  });

  it('derived_status ignores stopped agents in activity calculation', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'active' });
    insertAgent(db, { id: 'a2', task_id: 't1', window_index: 1, hook_activity: 'waiting' });

    const res = await request(app).get('/api/tasks').expect(200);
    // Stopped agent's 'active' is ignored; only running agent's 'waiting' counts
    expect(res.body[0].derived_status).toBe('needs_attention');
  });

  it('derived_status is null for non-running tasks', async () => {
    insertTask(db, { id: 't1', status: 'closed' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBeNull();
  });

  it('includes pending_prompts in single task response', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1' });
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: 'a1',
      tool_name: 'Edit',
      tool_input: '{"file_path":"server/api.ts"}',
    });

    const res = await request(app).get('/api/tasks/t1').expect(200);
    expect(res.body.pending_prompts).toHaveLength(1);
    expect(res.body.derived_status).toBe('working');
  });
});

// ─── POST /api/tasks/:id/agents/:agentId/message ────────────────────────────

describe('POST /api/tasks/:id/agents/:agentId/message', () => {
  it('sends message via tmux send-keys and returns success', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((_cmd: string, _args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (cb) cb(null, { stdout: '', stderr: '' });
      return undefined as any;
    }) as any);

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents/${DEFAULTS.agent.id}/message`)
      .send({ message: 'hello agent' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const calls = vi.mocked(execFileMock).mock.calls;
    const tmuxCall = calls.find(
      (c: any[]) => c[0] === 'tmux' && (c[1] as string[]).includes('send-keys'),
    );
    expect(tmuxCall).toBeDefined();
    const args = tmuxCall![1] as string[];
    expect(args).toContain('send-keys');
    expect(args).toContain('-t');
    expect(args).toContain(`${DEFAULTS.runningTask.tmux_session}:${DEFAULTS.agent.window_index}`);
    expect(args).toContain('hello agent');
    expect(args).toContain('Enter');
  });

  it('returns 404 when agent not found on existing task', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents/nonexistent/message`)
      .send({ message: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Agent not found');
  });

  it('returns 400 when task is not running', async () => {
    insertTask(db, { status: 'closed' });
    insertAgent(db);

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents/${DEFAULTS.agent.id}/message`)
      .send({ message: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not running');
  });

  it('returns 400 when message is missing', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents/${DEFAULTS.agent.id}/message`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message is required');
  });

  it('returns 400 when message is empty string', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/agents/${DEFAULTS.agent.id}/message`)
      .send({ message: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('message is required');
  });
});

// ─── POST /api/orchestrator/send ─────────────────────────────────────────────

describe('POST /api/orchestrator/send', () => {
  it('sends message when orchestrator is running', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(true);
    const res = await request(app)
      .post('/api/orchestrator/send')
      .send({ message: 'Show me all tasks' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, running: true });
    expect(sendToOrchestrator).toHaveBeenCalledWith('Show me all tasks');
  });

  it('auto-starts orchestrator when not running', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(false);
    const res = await request(app)
      .post('/api/orchestrator/send')
      .send({ message: 'Create a task' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, running: true });
    expect(startOrchestrator).toHaveBeenCalledWith(undefined, 'Create a task');
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app).post('/api/orchestrator/send').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('message is required');
  });

  it('returns 500 when orchestrator fails to start', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(false);
    vi.mocked(startOrchestrator).mockRejectedValueOnce(new Error('tmux failed'));
    const res = await request(app)
      .post('/api/orchestrator/send')
      .send({ message: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'tmux failed' });
  });
});
