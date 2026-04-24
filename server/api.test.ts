import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  insertUserTerminal,
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
        `UPDATE tasks SET status = 'running', tmux_session = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(`octomux-agent-${task.id}`, task.id);
      if (task.worktree_id) {
        db.prepare(`UPDATE worktrees SET path = ?, branch = COALESCE(branch, ?) WHERE id = ?`).run(
          `/tmp/.worktrees/${task.id}`,
          branch,
          task.worktree_id,
        );
      }
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
      return { editor: 'nvim', windowIndex: 5 };
    }),
    createShellTerminal: vi.fn(async (task: any) => {
      const { getDb } = await import('./db.js');
      const db = getDb();
      db.prepare(
        `INSERT INTO user_terminals (id, task_id, window_index, label, status) VALUES (?, ?, ?, ?, ?)`,
      ).run('new-terminal-id', task.id, 3, 'Terminal 1', 'idle');
      return {
        id: 'new-terminal-id',
        task_id: task.id,
        window_index: 3,
        label: 'Terminal 1',
        status: 'idle',
        created_at: '2026-01-01T00:00:00.000Z',
      };
    }),
    closeShellTerminal: vi.fn(),
    hopAgent: vi.fn(async (agent: any, toTaskId: string | null) => {
      const { getDb } = await import('./db.js');
      const db = getDb();
      db.prepare(
        `UPDATE agents SET task_id = ?, window_index = ?, tmux_session = ?, status = 'running' WHERE id = ?`,
      ).run(
        toTaskId,
        toTaskId === null ? 0 : 7,
        toTaskId === null ? `octomux-chat-${agent.id}` : null,
        agent.id,
      );
      return db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id);
    }),
  };
});

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readdirSync: vi.fn(() => []),
    existsSync: vi.fn(() => false),
    promises: {
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => []),
      access: vi.fn(async () => {}),
    },
  },
}));

vi.mock('./chats.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    createChat: vi.fn(async (opts: { label?: string; cwd?: string } = {}) => {
      const db = getDb();
      const id = 'chat-test-01';
      db.prepare(
        `INSERT INTO agents
           (id, task_id, window_index, label, status, claude_session_id,
            hook_activity, pinned, tmux_session, created_at)
         VALUES (?, NULL, 0, ?, 'running', ?, 'active', 0, ?, datetime('now'))`,
      ).run(id, opts.label ?? 'Chat', 'sid-01', `octomux-chat-${id}`);
      return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    }),
    listChats: vi.fn(() => {
      const db = getDb();
      return db.prepare(`SELECT * FROM agents WHERE task_id IS NULL ORDER BY pinned DESC`).all();
    }),
    getChat: vi.fn((id: string) => {
      const db = getDb();
      return db.prepare(`SELECT * FROM agents WHERE id = ? AND task_id IS NULL`).get(id) ?? null;
    }),
  };
});

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

vi.mock('./skills.js', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({
    editor: 'nvim',
    useOrchestratorAgent: false,
    dangerouslySkipPermissions: false,
    claudeFlags: '',
  })),
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
    editor: 'nvim',
    useOrchestratorAgent: false,
    dangerouslySkipPermissions: false,
    claudeFlags: '',
    ...patch,
  })),
}));

vi.mock('./diff.js', () => ({
  getDiffSummary: vi.fn(),
  getFileDiff: vi.fn(),
  safeResolvePath: (wt: string, p: string) => {
    if (!p || p.includes('..') || p.startsWith('/')) throw new Error('Invalid path');
    return `${wt}/${p}`;
  },
  MAX_FILE_BYTES: 1_048_576,
}));

const fs = (await import('fs')).default;
const diffModule = await import('./diff.js');

const { createApp } = await import('./app.js');
const {
  startTask,
  closeTask,
  deleteTask,
  resumeTask,
  addAgent,
  stopAgent,
  createUserTerminal,
  createShellTerminal,
  closeShellTerminal,
} = await import('./task-runner.js');
const { isOrchestratorRunning, startOrchestrator, sendToOrchestrator } =
  await import('./orchestrator.js');
const { listSkills, getSkill, createSkill, updateSkill, deleteSkill } = await import('./skills.js');
const { updateSettings } = await import('./settings.js');

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

// ─── Inbox ──────────────────────────────────────────────────────────────────

describe('GET /api/tasks/inbox', () => {
  it('returns both buckets', async () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    insertTask(db, { id: 'err', status: 'error', last_viewed_at: null, updated_at: now });
    insertTask(db, { id: 'closed', status: 'closed', last_viewed_at: null, updated_at: now });

    const res = await request(app).get('/api/tasks/inbox');
    expect(res.status).toBe(200);
    expect(res.body.needs_you.map((t: Task) => t.id)).toEqual(['err']);
    expect(res.body.activity.map((t: Task) => t.id)).toEqual(['closed']);
  });

  it('returns empty arrays when no tasks match', async () => {
    const res = await request(app).get('/api/tasks/inbox');
    expect(res.body).toEqual({ needs_you: [], activity: [] });
  });
});

describe('PATCH /api/tasks/:id/viewed', () => {
  it('sets last_viewed_at on the task', async () => {
    insertTask(db);
    const before = getTask(db, DEFAULTS.task.id);
    expect(before?.last_viewed_at).toBeNull();

    const res = await request(app).patch(`/api/tasks/${DEFAULTS.task.id}/viewed`);
    expect(res.status).toBe(200);
    expect(res.body.last_viewed_at).toBeTruthy();

    const after = getTask(db, DEFAULTS.task.id);
    expect(after?.last_viewed_at).toBeTruthy();
  });

  it('returns 404 for missing task', async () => {
    const res = await request(app).patch('/api/tasks/nope/viewed');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/viewed-all', () => {
  it('marks every task as viewed and reports count', async () => {
    insertTask(db, { id: 'a' });
    insertTask(db, { id: 'b' });
    insertTask(db, { id: 'c' });

    const res = await request(app).post('/api/tasks/viewed-all');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);

    for (const id of ['a', 'b', 'c']) {
      expect(getTask(db, id)?.last_viewed_at).toBeTruthy();
    }
  });

  it('returns 0 when no tasks', async () => {
    const res = await request(app).post('/api/tasks/viewed-all');
    expect(res.body.updated).toBe(0);
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
    expect(res.body.status).toBe('setting_up');
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
    await vi.waitFor(() => {
      expect(startTask).toHaveBeenCalledOnce();
    });
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

    // Branch is set by startTask (runs in background), not in the immediate response
    expect(res.body.branch).toBeNull();

    // Wait for the fire-and-forget startTask to complete
    await vi.waitFor(() => {
      const task = getTask(db, res.body.id);
      expect(task?.branch).toContain('agents/');
    });
  });

  it('stores initial_prompt when provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, initial_prompt: 'Fix the bug in orders.ts' });

    expect(res.status).toBe(201);
    const task = getTask(db, res.body.id);
    expect(task?.initial_prompt).toBe('Fix the bug in orders.ts');
  });

  it('stores run_mode=none when provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, run_mode: 'none' });

    expect(res.status).toBe(201);
    const task = getTask(db, res.body.id);
    expect(task?.run_mode).toBe('none');
  });

  it('defaults run_mode to new when not provided', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);

    expect(res.status).toBe(201);
    const task = getTask(db, res.body.id);
    expect(task?.run_mode).toBe('new');
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

  it.each(resumableStatuses)(
    'resumes run_mode=none %s task when repo_path exists',
    async (status) => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      insertTask(db, {
        ...DEFAULTS.runningTask,
        status,
        run_mode: 'none',
        worktree: DEFAULTS.runningTask.repo_path,
      });
      const res = await request(app)
        .patch(`/api/tasks/${DEFAULTS.task.id}`)
        .send({ status: 'running' });
      expect(res.status).toBe(200);
      expect(resumeTask).toHaveBeenCalledOnce();
    },
  );

  it.each(resumableStatuses)(
    'refuses resume of run_mode=none %s task when repo_path missing',
    async (status) => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      insertTask(db, {
        ...DEFAULTS.runningTask,
        status,
        run_mode: 'none',
        worktree: DEFAULTS.runningTask.repo_path,
      });
      const res = await request(app)
        .patch(`/api/tasks/${DEFAULTS.task.id}`)
        .send({ status: 'running' });
      expect(res.status).toBe(400);
    },
  );

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

  it('updates run_mode on draft task', async () => {
    insertTask(db);
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ run_mode: 'none' });
    expect(res.status).toBe(200);
    const task = getTask(db, res.body.id);
    expect(task?.run_mode).toBe('none');
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

// ─── GET /api/tasks/:id/diff ─────────────────────────────────────────────────

describe('GET /api/tasks/:id/diff', () => {
  beforeEach(() => {
    (fs.existsSync as any).mockReturnValue(true);
    (diffModule.getDiffSummary as any).mockReset();
    (diffModule.getFileDiff as any).mockReset();
  });

  it('returns 404 when task does not exist', async () => {
    const res = await request(app).get('/api/tasks/missing/diff');
    expect(res.status).toBe(404);
  });

  it('returns 400 when task has no worktree', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, worktree: null });
    // Explicitly null the worktree row path so the diff handler reports absence.
    db.prepare(
      `UPDATE worktrees SET path = '' WHERE id = (SELECT worktree_id FROM tasks WHERE id = ?)`,
    ).run(DEFAULTS.runningTask.id);
    db.prepare(`UPDATE tasks SET worktree_id = NULL WHERE id = ?`).run(DEFAULTS.runningTask.id);
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/worktree/i);
  });

  it('returns 400 when worktree dir no longer exists', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (fs.existsSync as any).mockReturnValue(false);
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(400);
  });

  it('returns 400 when task has no base_sha', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, base_sha: null });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base_sha/i);
  });

  it('returns 400 for scratch task', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      run_mode: 'scratch',
      base_sha: null,
      worktree: '/scratch/x',
    });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scratch/i);
  });

  it('returns a diff summary', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (diffModule.getDiffSummary as any).mockResolvedValue({
      files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }],
    });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }]);
  });
});

// ─── GET /api/tasks/:id/diff/:path ───────────────────────────────────────────

describe('GET /api/tasks/:id/diff/:path', () => {
  beforeEach(() => {
    (fs.existsSync as any).mockReturnValue(true);
    (diffModule.getDiffSummary as any).mockReset();
    (diffModule.getFileDiff as any).mockReset();
  });

  it('returns 404 when task does not exist', async () => {
    const res = await request(app).get('/api/tasks/missing/diff/a.txt');
    expect(res.status).toBe(404);
  });

  it('rejects path traversal', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).get(
      `/api/tasks/${DEFAULTS.runningTask.id}/diff/..%2Fetc%2Fpasswd`,
    );
    expect(res.status).toBe(400);
  });

  it('returns old/new content for a file', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (diffModule.getFileDiff as any).mockResolvedValue({
      oldContent: 'old\n',
      newContent: 'new\n',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff/a.txt`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      oldContent: 'old\n',
      newContent: 'new\n',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
  });

  it('passes a nested path correctly to getFileDiff', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (diffModule.getFileDiff as any).mockResolvedValue({
      oldContent: '',
      newContent: 'export const x = 1;\n',
      status: 'A',
      tooLarge: false,
      binary: false,
    });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff/src/lib/foo.ts`);
    expect(res.status).toBe(200);
    expect(diffModule.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'src/lib/foo.ts' }),
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
    vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(fs.promises.readdir).mockResolvedValue(['project-a', 'project-b'] as any);
    vi.mocked(fs.promises.access).mockImplementation(async (p: any) => {
      if (String(p).includes('project-a/.git')) return;
      throw new Error('ENOENT');
    });

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
    vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);

    const res = await request(app).get('/api/browse?path=/home/user');
    expect(res.body.parent).toBe('/home');
  });

  it('returns null parent for root directory', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);

    const res = await request(app).get('/api/browse?path=/');
    expect(res.body.parent).toBeNull();
  });

  it('returns 400 when path is not a directory', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => false } as any);

    const res = await request(app).get('/api/browse?path=/tmp/file.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not a directory');
  });

  it('returns 400 when path does not exist', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));

    const res = await request(app).get('/api/browse?path=/nonexistent');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not exist');
  });

  it('skips non-directory entries', async () => {
    vi.mocked(fs.promises.stat).mockImplementation(async (p: any) => {
      const pathStr = String(p);
      if (pathStr === '/tmp') return { isDirectory: () => true } as any;
      if (pathStr.includes('file.txt')) return { isDirectory: () => false } as any;
      return { isDirectory: () => true } as any;
    });
    vi.mocked(fs.promises.readdir).mockResolvedValue(['dir1', 'file.txt'] as any);
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));

    const res = await request(app).get('/api/browse?path=/tmp');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].name).toBe('dir1');
  });

  it('sorts hidden directories after non-hidden', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
    vi.mocked(fs.promises.readdir).mockResolvedValue(['.hidden', 'visible'] as any);
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));

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
    expect(res.body).toEqual({ editor: 'nvim', windowIndex: 5 });
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

// ─── POST /api/tasks/:id/terminals ──────────────────────────────────────────

describe('POST /api/tasks/:id/terminals', () => {
  it('creates a terminal for a running task', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    const res = await request(app).post(`/api/tasks/${DEFAULTS.runningTask.id}/terminals`);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Terminal 1');
    expect(createShellTerminal).toHaveBeenCalled();
  });

  it('returns 400 for non-running task', async () => {
    insertTask(db);
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/terminals`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app).post('/api/tasks/unknown/terminals');
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /api/tasks/:id/terminals/:terminalId ────────────────────────────

describe('DELETE /api/tasks/:id/terminals/:terminalId', () => {
  it('closes a terminal', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const res = await request(app).delete(
      `/api/tasks/${DEFAULTS.runningTask.id}/terminals/${DEFAULTS.userTerminal.id}`,
    );
    expect(res.status).toBe(204);
    expect(closeShellTerminal).toHaveBeenCalled();
  });

  it('returns 404 for unknown terminal', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const res = await request(app).delete(
      `/api/tasks/${DEFAULTS.runningTask.id}/terminals/unknown`,
    );
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/tasks/:id — user_terminals ────────────────────────────────────

describe('GET /api/tasks/:id — user_terminals', () => {
  it('includes user_terminals array in response', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user_terminals).toHaveLength(1);
    expect(res.body.user_terminals[0].label).toBe('Terminal 1');
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
    const res = await request(app).post('/api/orchestrator/send').send({ message: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'tmux failed' });
  });
});

// ─── Skills API ──────────────────────────────────────────────────────────────

describe('Skills API', () => {
  it('GET /api/skills returns skill list', async () => {
    vi.mocked(listSkills).mockResolvedValue([{ name: 'my-skill', description: 'A test skill' }]);
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'my-skill', description: 'A test skill' }]);
  });

  it('GET /api/skills/:name returns skill content', async () => {
    vi.mocked(getSkill).mockResolvedValue({ name: 'my-skill', content: '# My Skill' });
    const res = await request(app).get('/api/skills/my-skill');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'my-skill', content: '# My Skill' });
  });

  it('GET /api/skills/:name returns 404 for missing', async () => {
    vi.mocked(getSkill).mockRejectedValue(new Error('Skill not found: missing'));
    const res = await request(app).get('/api/skills/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('POST /api/skills creates skill (201)', async () => {
    vi.mocked(createSkill).mockResolvedValue({ name: 'new-skill', content: '# New' });
    const res = await request(app)
      .post('/api/skills')
      .send({ name: 'new-skill', content: '# New' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'new-skill', content: '# New' });
  });

  it('POST /api/skills returns 400 when name missing', async () => {
    const res = await request(app).post('/api/skills').send({ content: '# No name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name is required');
  });

  it('POST /api/skills returns 409 when exists', async () => {
    vi.mocked(createSkill).mockRejectedValue(new Error('Skill already exists: dupe'));
    const res = await request(app).post('/api/skills').send({ name: 'dupe', content: '# Dupe' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('PUT /api/skills/:name updates content', async () => {
    vi.mocked(updateSkill).mockResolvedValue({ name: 'my-skill', content: '# Updated' });
    const res = await request(app).put('/api/skills/my-skill').send({ content: '# Updated' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'my-skill', content: '# Updated' });
  });

  it('PUT /api/skills/:name returns 400 when content missing', async () => {
    const res = await request(app).put('/api/skills/my-skill').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('content is required');
  });

  it('DELETE /api/skills/:name removes skill (204)', async () => {
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    const res = await request(app).delete('/api/skills/my-skill');
    expect(res.status).toBe(204);
  });

  it('DELETE /api/skills/:name returns 404 for missing', async () => {
    vi.mocked(deleteSkill).mockRejectedValue(new Error('Skill not found: missing'));
    const res = await request(app).delete('/api/skills/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_CLAUDE_FLAGS;
  });

  it('returns default settings with envOverrides', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      editor: 'nvim',
      useOrchestratorAgent: false,
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      envOverrides: { claudeFlags: null },
    });
  });

  it('surfaces OCTOMUX_CLAUDE_FLAGS in envOverrides when set', async () => {
    process.env.OCTOMUX_CLAUDE_FLAGS = '--model opus';
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.envOverrides).toEqual({ claudeFlags: '--model opus' });
  });
});

describe('PATCH /api/settings', () => {
  it('updates editor setting', async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      editor: 'cursor',
      useOrchestratorAgent: false,
      dangerouslySkipPermissions: false,
      claudeFlags: '',
    });
    const res = await request(app).patch('/api/settings').send({ editor: 'cursor' });
    expect(res.status).toBe(200);
    expect(res.body.editor).toBe('cursor');
  });

  it('rejects invalid editor', async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error('Invalid editor: emacs'));
    const res = await request(app).patch('/api/settings').send({ editor: 'emacs' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when claudeFlags validation fails', async () => {
    vi.mocked(updateSettings).mockRejectedValue(
      new Error('Invalid claudeFlags: backticks are not allowed'),
    );
    const res = await request(app).patch('/api/settings').send({ claudeFlags: '`whoami`' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid claudeFlags');
  });
});

describe('Chats API (standalone agents)', () => {
  it('POST /api/chats creates a standalone agent (task_id=NULL)', async () => {
    const res = await request(app).post('/api/chats').send({ label: 'My chat' });
    expect(res.status).toBe(201);
    expect(res.body.task_id).toBeNull();
    expect(res.body.label).toBe('My chat');
    expect(res.body.tmux_session).toMatch(/^octomux-chat-/);
  });

  it('GET /api/chats lists standalone agents, orchestrator pinned first', async () => {
    await request(app).post('/api/chats').send({ label: 'Chat A' });
    const res = await request(app).get('/api/chats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Orchestrator is seeded on init with pinned=1 and should sort first.
    expect(res.body[0].id).toBe('orchestrator');
    expect(res.body[0].pinned).toBe(1);
  });

  it('GET /api/chats/:id returns a chat by id', async () => {
    const created = await request(app).post('/api/chats').send({ label: 'Chat B' });
    const res = await request(app).get(`/api/chats/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.label).toBe('Chat B');
  });

  it('GET /api/chats/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/chats/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/worktrees', () => {
  it('returns an empty list when no worktrees exist', async () => {
    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns worktree rows with task_count aggregate', async () => {
    // Seed worktree + linked task.
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wt1','/tmp/wt1','new','in_use')`,
    ).run();
    insertTask(db, { id: 'tX', worktree_id: 'wt1', status: 'running' });

    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('wt1');
    expect(res.body[0].task_count).toBe(1);
    expect(res.body[0].active_task_id).toBe('tX');
  });
});

describe('GET /api/worktrees/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/worktrees/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns the worktree plus active task and history', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, mode, status)
       VALUES ('wtD1','/tmp/wtD1','/repo','new','in_use')`,
    ).run();
    insertTask(db, { id: 'tActive', worktree_id: 'wtD1', status: 'running' });
    insertTask(db, {
      id: 'tClosed',
      worktree_id: 'wtD1',
      status: 'closed',
      updated_at: '2026-01-01 00:00:00',
    });

    const res = await request(app).get('/api/worktrees/wtD1');
    expect(res.status).toBe(200);
    expect(res.body.worktree.id).toBe('wtD1');
    expect(res.body.active_task?.id).toBe('tActive');
    expect(res.body.history.map((t: Task) => t.id)).toEqual(['tClosed']);
  });

  it('returns null active_task when none active', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wtD2','/tmp/wtD2','new','available')`,
    ).run();
    insertTask(db, { id: 'tX', worktree_id: 'wtD2', status: 'closed' });

    const res = await request(app).get('/api/worktrees/wtD2');
    expect(res.status).toBe(200);
    expect(res.body.active_task).toBeNull();
    expect(res.body.history).toHaveLength(1);
  });
});

describe('DELETE /api/worktrees/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/worktrees/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('409 when worktree is in_use', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wtU1','/tmp/wtU1','new','in_use')`,
    ).run();
    const res = await request(app).delete('/api/worktrees/wtU1');
    expect(res.status).toBe(409);
  });

  it('409 when active task references it', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wtA1','/tmp/wtA1','new','available')`,
    ).run();
    insertTask(db, { id: 'tRun', worktree_id: 'wtA1', status: 'running' });

    const res = await request(app).delete('/api/worktrees/wtA1');
    expect(res.status).toBe(409);
  });

  it('deletes row when available with no active tasks', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wtOK','/tmp/wtOK','existing','available')`,
    ).run();
    insertTask(db, { id: 'tTerm', worktree_id: 'wtOK', status: 'closed' });

    const res = await request(app).delete('/api/worktrees/wtOK');
    expect(res.status).toBe(204);
    const remaining = db.prepare(`SELECT id FROM worktrees WHERE id = 'wtOK'`).get();
    expect(remaining).toBeUndefined();
    const task = db.prepare(`SELECT worktree_id FROM tasks WHERE id = 'tTerm'`).get() as {
      worktree_id: string | null;
    };
    expect(task.worktree_id).toBeNull();
  });
});

describe('PATCH /api/agents/:id/task', () => {
  it('404 when agent does not exist', async () => {
    const res = await request(app)
      .patch('/api/agents/missing/task')
      .send({ task_id: null });
    expect(res.status).toBe(404);
  });

  it('400 when body missing task_id key', async () => {
    insertAgent(db, { id: 'aBody', task_id: null });
    const res = await request(app).patch('/api/agents/aBody/task').send({});
    expect(res.status).toBe(400);
  });

  it('400 when task_id equals current task_id (no-op)', async () => {
    insertTask(db, { id: 'tSame', status: 'running' });
    insertAgent(db, { id: 'aSame', task_id: 'tSame' });
    const res = await request(app)
      .patch('/api/agents/aSame/task')
      .send({ task_id: 'tSame' });
    expect(res.status).toBe(400);
  });

  it('404 when target task does not exist', async () => {
    insertAgent(db, { id: 'aOrph', task_id: null });
    const res = await request(app)
      .patch('/api/agents/aOrph/task')
      .send({ task_id: 'does-not-exist' });
    expect(res.status).toBe(404);
  });

  it('409 when target task is not active', async () => {
    insertTask(db, { id: 'tClosed', status: 'closed' });
    insertAgent(db, { id: 'aC', task_id: null });
    const res = await request(app)
      .patch('/api/agents/aC/task')
      .send({ task_id: 'tClosed' });
    expect(res.status).toBe(409);
  });

  it('detaches to standalone (task_id=null)', async () => {
    insertTask(db, { id: 'tFrom', status: 'running' });
    insertAgent(db, { id: 'aDet', task_id: 'tFrom' });

    const res = await request(app)
      .patch('/api/agents/aDet/task')
      .send({ task_id: null });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBeNull();
    expect(res.body.tmux_session).toBe('octomux-chat-aDet');
  });

  it('moves between tasks', async () => {
    insertTask(db, { id: 'tA', status: 'running' });
    insertTask(db, { id: 'tB', status: 'running' });
    insertAgent(db, { id: 'aMove', task_id: 'tA' });

    const res = await request(app).patch('/api/agents/aMove/task').send({ task_id: 'tB' });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('tB');
  });

  it('attaches a standalone chat agent to a task', async () => {
    insertTask(db, { id: 'tTarget', status: 'running' });
    insertAgent(db, { id: 'aChat', task_id: null });
    // Standalone agents carry their own tmux_session.
    db.prepare(`UPDATE agents SET tmux_session = 'octomux-chat-aChat' WHERE id = 'aChat'`).run();

    const res = await request(app).patch('/api/agents/aChat/task').send({ task_id: 'tTarget' });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('tTarget');
  });
});

describe('GET /api/tasks/:id — worktree_row join', () => {
  it('includes the linked worktree row under worktree_row', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wt2','/tmp/wt2','existing','in_use')`,
    ).run();
    insertTask(db, { id: 'tJ', worktree_id: 'wt2' });
    const res = await request(app).get('/api/tasks/tJ');
    expect(res.status).toBe(200);
    expect(res.body.worktree_row).toBeTruthy();
    expect(res.body.worktree_row.id).toBe('wt2');
    expect(res.body.worktree_row.path).toBe('/tmp/wt2');
  });

  it('worktree_row is null when task has no worktree_id', async () => {
    insertTask(db, { id: 'tK' });
    db.prepare(`UPDATE tasks SET worktree_id = NULL WHERE id = 'tK'`).run();
    const res = await request(app).get('/api/tasks/tK');
    expect(res.status).toBe(200);
    expect(res.body.worktree_row).toBeNull();
  });
});
