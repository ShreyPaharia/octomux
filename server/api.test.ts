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

vi.mock('./task-engine/index.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    startTask: vi.fn(async (task: any) => {
      const db = getDb();
      const branch = task.branch || `agents/${task.id}`;
      db.prepare(
        `UPDATE tasks SET runtime_state = 'running', tmux_session = ?, updated_at = datetime('now') WHERE id = ?`,
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
        `UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare('UPDATE agents SET status = ? WHERE task_id = ?').run('stopped', task.id);
    }),
    softDeleteTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET deleted_at = datetime('now'), runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(`UPDATE agents SET status = 'stopped' WHERE task_id = ?`).run(task.id);
    }),
    deleteTask: vi.fn(),
    resumeTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET runtime_state = 'running', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(
        "UPDATE agents SET status = 'running' WHERE task_id = ? AND status = 'stopped'",
      ).run(task.id);
    }),
    addAgent: vi.fn(async (_task: any, _opts?: any) => ({
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
  let counter = 0;
  return {
    createChat: vi.fn(
      async (opts: { label?: string; cwd?: string; agent?: string | null } = {}) => {
        const db = getDb();
        counter += 1;
        const id = `chat-test-${counter.toString().padStart(2, '0')}`;
        db.prepare(
          `INSERT INTO agents
             (id, task_id, window_index, label, status, harness_id, harness_session_id,
              hook_token, hook_activity, tmux_session, agent, created_at)
           VALUES (?, NULL, 0, ?, 'running', 'claude-code', ?, '', 'active', ?, ?, datetime('now'))`,
        ).run(id, opts.label ?? 'Chat', `sid-${id}`, `octomux-chat-${id}`, opts.agent ?? null);
        return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
      },
    ),
    listChats: vi.fn(() => {
      const db = getDb();
      return db.prepare(`SELECT * FROM agents WHERE task_id IS NULL ORDER BY created_at ASC`).all();
    }),
    getChat: vi.fn((id: string) => {
      const db = getDb();
      return db.prepare(`SELECT * FROM agents WHERE id = ? AND task_id IS NULL`).get(id) ?? null;
    }),
    closeChat: vi.fn(async (chat: { id: string }) => {
      const db = getDb();
      db.prepare(
        `UPDATE agents SET status = 'stopped', hook_activity = 'idle',
            hook_activity_updated_at = datetime('now')
          WHERE id = ?`,
      ).run(chat.id);
    }),
    deleteChat: vi.fn(async (chat: { id: string }) => {
      const db = getDb();
      db.prepare('DELETE FROM agents WHERE id = ?').run(chat.id);
    }),
  };
});

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
    defaultHarnessId: 'claude-code',
    harnesses: {},
  })),
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
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
} = await import('./task-engine/index.js');
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

  it('excludes auto_review tasks from the list', async () => {
    insertTask(db, { id: 'regular', source: null });
    insertTask(db, { id: 'review', source: 'auto_review' });

    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.map((t: Task) => t.id)).toEqual(['regular']);
  });
});

// ─── Inbox ──────────────────────────────────────────────────────────────────

describe('GET /api/tasks/inbox', () => {
  it('returns both buckets', async () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    insertTask(db, { id: 'err', runtime_state: 'error', last_viewed_at: null, updated_at: now });
    insertTask(db, { id: 'closed', runtime_state: 'idle', last_viewed_at: null, updated_at: now });

    const res = await request(app).get('/api/tasks/inbox');
    expect(res.status).toBe(200);
    expect(res.body.needs_you.map((t: Task) => t.id)).toEqual(['err']);
    expect(res.body.activity.map((t: Task) => t.id)).toEqual(['closed']);
  });

  it('returns empty arrays when no tasks match', async () => {
    const res = await request(app).get('/api/tasks/inbox');
    expect(res.body).toEqual({ needs_you: [], activity: [] });
  });

  it('excludes auto_review tasks from inbox buckets', async () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    insertTask(db, {
      id: 'review-err',
      source: 'auto_review',
      runtime_state: 'error',
      last_viewed_at: null,
      updated_at: now,
    });
    insertTask(db, {
      id: 'regular-err',
      source: null,
      runtime_state: 'error',
      last_viewed_at: null,
      updated_at: now,
    });

    const res = await request(app).get('/api/tasks/inbox');
    expect(res.body.needs_you.map((t: Task) => t.id)).toEqual(['regular-err']);
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
    expect(res.body.runtime_state).toBe('setting_up');
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
    expect(res.body.runtime_state).toBe('idle');
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

  it('allows run_mode=none with base_branch (new behavior)', async () => {
    const res = await request(app).post('/api/tasks').send({
      title: 't',
      description: 'd',
      run_mode: 'none',
      repo_path: '/tmp/repo',
      base_branch: 'feature-x',
    });
    // We allow the request to pass validation; downstream setup may still fail
    // when the repo path is fake. Accept any non-400 status.
    expect(res.status).not.toBe(400);
  });

  it('still rejects run_mode=none with branch', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 't', description: 'd', run_mode: 'none', repo_path: '/r', branch: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch and worktree_path are not allowed for run_mode=none/);
  });

  it('still rejects run_mode=none with worktree_path', async () => {
    const res = await request(app).post('/api/tasks').send({
      title: 't',
      description: 'd',
      run_mode: 'none',
      repo_path: '/r',
      worktree_path: '/r/.worktrees/x',
    });
    expect(res.status).toBe(400);
  });

  it('defaults run_mode to new when not provided', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);

    expect(res.status).toBe(201);
    const task = getTask(db, res.body.id);
    expect(task?.run_mode).toBe('new');
  });

  it('persists model when provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ ...validPayload, model: 'claude-sonnet-4-6' });

    expect(res.status).toBe(201);
    expect(res.body.model).toBe('claude-sonnet-4-6');
    const task = getTask(db, res.body.id);
    expect((task as any).model).toBe('claude-sonnet-4-6');
  });

  it('returns null model when not provided', async () => {
    const res = await request(app).post('/api/tasks').send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.model).toBeNull();
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

  const nonDraftStates = ['setting_up', 'running', 'error'];

  it.each(nonDraftStates)('returns 400 when task runtime_state is %s', async (state) => {
    insertTask(db, { runtime_state: state as any });
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
    expect(res.body.runtime_state).toBe('idle');
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
    expect(res.body.runtime_state).toBe('running'); // unchanged
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

  const resumableStates = ['idle', 'error'] as const;

  it.each(resumableStates)('returns 400 when worktree missing for %s task', async (state) => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: state });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Worktree');
  });

  it.each(resumableStates)('calls resumeTask for %s task with valid worktree', async (state) => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: state });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(200);
    expect(resumeTask).toHaveBeenCalledOnce();
  });

  it.each(resumableStates)('resumes run_mode=none %s task when repo_path exists', async (state) => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    insertTask(db, {
      ...DEFAULTS.runningTask,
      runtime_state: state,
      run_mode: 'none',
      worktree: DEFAULTS.runningTask.repo_path,
    });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(200);
    expect(resumeTask).toHaveBeenCalledOnce();
  });

  it.each(resumableStates)(
    'refuses resume of run_mode=none %s task when repo_path missing',
    async (state) => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      insertTask(db, {
        ...DEFAULTS.runningTask,
        runtime_state: state,
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
    insertTask(db); // default runtime_state is 'idle' (draft)
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
  it('soft-deletes task by default and returns 204 (row still exists)', async () => {
    insertTask(db);
    const res = await request(app).delete(`/api/tasks/${DEFAULTS.task.id}`);
    expect(res.status).toBe(204);
    // Row still exists — soft delete, not hard delete
    const row = db
      .prepare('SELECT deleted_at FROM tasks WHERE id = ?')
      .get(DEFAULTS.task.id) as any;
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
  });

  it('?purge=true hard-deletes a soft-deleted task and calls deleteTask', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?`).run(DEFAULTS.task.id);
    await request(app).delete(`/api/tasks/${DEFAULTS.task.id}?purge=true`);
    expect(deleteTask).toHaveBeenCalledOnce();
    expect(getTask(db, DEFAULTS.task.id)).toBeUndefined();
  });

  it('soft-delete sets stopped on agents (does not cascade-delete them)', async () => {
    insertTask(db);
    insertAgent(db);
    await request(app).delete(`/api/tasks/${DEFAULTS.task.id}`);
    // Agents still exist but are stopped
    const agents = db
      .prepare('SELECT * FROM agents WHERE task_id = ?')
      .all(DEFAULTS.task.id) as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('stopped');
  });
});

// ─── POST /api/tasks/:id/move ────────────────────────────────────────────────

describe('POST /api/tasks/:id/move', () => {
  it('updates workflow_status without auto-starting for non-in_progress moves', async () => {
    insertTask(db, { workflow_status: 'backlog', initial_prompt: 'do the thing' });
    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/move`)
      .send({ workflow_status: 'planned', note: 'queued for next sprint' });

    expect(res.status).toBe(200);
    expect(res.body.workflow_status).toBe('planned');
    expect(startTask).not.toHaveBeenCalled();
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('triggers startTask when moving to in_progress from idle without worktree', async () => {
    insertTask(db, {
      workflow_status: 'planned',
      initial_prompt: 'do the thing',
      runtime_state: 'idle',
      worktree: null,
    });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/move`)
      .send({ workflow_status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body.workflow_status).toBe('in_progress');
    // Synchronous flip to setting_up; the fire-and-forget startTask completes
    // afterwards (its mock would later flip to running) but isn't observable
    // in this response.
    expect(res.body.runtime_state).toBe('setting_up');
    expect(startTask).toHaveBeenCalledOnce();
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('triggers resumeTask when moving to in_progress from idle with existing worktree', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      runtime_state: 'idle',
      workflow_status: 'planned',
    });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/move`)
      .send({ workflow_status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(resumeTask).toHaveBeenCalledOnce();
    expect(startTask).not.toHaveBeenCalled();
  });

  it('triggers resumeTask when moving to in_progress from error with worktree', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      runtime_state: 'error',
      workflow_status: 'in_progress',
      error: 'previous failure',
    });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/move`)
      .send({ workflow_status: 'in_progress', note: 'retry it' });

    // Same column move is a no-op in the dnd-kit board, but the API itself
    // doesn't reject it — exercise the error-retry branch via a real transition.
    expect(res.status).toBe(200);
    expect(resumeTask).toHaveBeenCalledOnce();

    // Verify error column was cleared as part of the auto-start setup flip.
    const updated = getTask(db, DEFAULTS.task.id);
    expect(updated?.error).toBeNull();
  });

  it('does not auto-start when task is already running', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, workflow_status: 'planned' });

    const res = await request(app)
      .post(`/api/tasks/${DEFAULTS.task.id}/move`)
      .send({ workflow_status: 'in_progress' });

    expect(res.status).toBe(200);
    expect(startTask).not.toHaveBeenCalled();
    expect(resumeTask).not.toHaveBeenCalled();
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

  it('forwards parsed range to getFileDiff', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (diffModule.getFileDiff as any).mockResolvedValue({
      oldContent: 'old\n',
      newContent: 'new\n',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    const res = await request(app).get(
      `/api/tasks/${DEFAULTS.runningTask.id}/diff/a.txt?range=working`,
    );
    expect(res.status).toBe(200);
    expect(diffModule.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ range: { kind: 'working' }, relPath: 'a.txt' }),
    );
  });

  it('rejects malformed range param with 400', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).get(
      `/api/tasks/${DEFAULTS.runningTask.id}/diff/a.txt?range=garbage`,
    );
    expect(res.status).toBe(400);
  });
});

// ─── New range/base routes ───────────────────────────────────────────────────

describe('GET /api/tasks/:id/branches', () => {
  beforeEach(() => {
    (fs.existsSync as any).mockReturnValue(true);
  });

  it('returns deduped branches with current and default', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (args.includes('branch')) {
        cb(null, { stdout: 'main\nfeature\norigin/main\norigin/topic\n', stderr: '' });
      } else if (args.includes('symbolic-ref')) {
        if (args.includes('refs/remotes/origin/HEAD')) {
          cb(null, { stdout: 'origin/main\n', stderr: '' });
        } else {
          cb(null, { stdout: 'feature\n', stderr: '' });
        }
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/branches`);
    expect(res.status).toBe(200);
    expect(res.body.branches).toEqual(['feature', 'main', 'topic']);
    expect(res.body.current).toBe('feature');
    expect(res.body.default).toBe('main');
  });

  it('returns 400 for scratch task', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      run_mode: 'scratch',
      base_sha: null,
      worktree: '/scratch/x',
    });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/branches`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks/:id/commits', () => {
  beforeEach(() => {
    (fs.existsSync as any).mockReturnValue(true);
  });

  it('parses TSV log output and respects limit', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const { execFile: execFileMock } = await import('child_process');
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    const line = `${sha}\tabcdef0\tfix(diff): something\tAlice\talice@example.com\t2026-04-30T12:00:00Z`;
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (args.includes('log')) {
        cb(null, { stdout: `${line}\n${line}\n`, stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/commits?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.commits).toHaveLength(1);
    expect(res.body.commits[0]).toEqual({
      sha,
      short_sha: 'abcdef0',
      subject: 'fix(diff): something',
      author: 'Alice',
      author_email: 'alice@example.com',
      authored_at: '2026-04-30T12:00:00Z',
    });
    expect(res.body.truncated).toBe(true);
  });

  it('returns empty for working range without calling git log', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).get(
      `/api/tasks/${DEFAULTS.runningTask.id}/commits?range=working`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ commits: [], truncated: false });
  });

  it('rejects malformed range with 400', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).get(
      `/api/tasks/${DEFAULTS.runningTask.id}/commits?range=commit:not-hex`,
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/tasks/:id/base', () => {
  beforeEach(() => {
    (fs.existsSync as any).mockReturnValue(true);
  });

  it('updates worktree.base_branch + base_sha and returns reloaded task', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const { execFile: execFileMock } = await import('child_process');
    const newSha = '1111111111111111111111111111111111111111';
    vi.mocked(execFileMock).mockImplementation(((cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (args.includes('rev-parse')) {
        cb(null, { stdout: `${newSha}\n`, stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.runningTask.id}/base`)
      .send({ base_branch: 'develop' });
    expect(res.status).toBe(200);
    expect(res.body.base_branch).toBe('develop');
    expect(res.body.base_sha).toBe(newSha);

    const wt = db
      .prepare('SELECT base_branch, base_sha FROM worktrees WHERE id = ?')
      .get(`wt-${DEFAULTS.runningTask.id}`) as { base_branch: string; base_sha: string };
    expect(wt.base_branch).toBe('develop');
    expect(wt.base_sha).toBe(newSha);
  });

  it('returns 400 when base_branch ref does not resolve', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const { execFile: execFileMock } = await import('child_process');
    vi.mocked(execFileMock).mockImplementation(((_cmd: string, args: any, ...rest: any[]) => {
      const cb = rest.find((a: any) => typeof a === 'function');
      if (args.includes('rev-parse')) {
        cb(new Error('unknown revision'), null);
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.runningTask.id}/base`)
      .send({ base_branch: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for scratch task', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      run_mode: 'scratch',
      base_sha: null,
      worktree: '/scratch/x',
    });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.runningTask.id}/base`)
      .send({ base_branch: 'main' });
    expect(res.status).toBe(400);
  });

  it('returns 409 for draft task', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: 'idle' });
    const res = await request(app)
      .patch(`/api/tasks/${DEFAULTS.runningTask.id}/base`)
      .send({ base_branch: 'main' });
    expect(res.status).toBe(409);
  });

  it('returns 400 when base_branch is missing', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).patch(`/api/tasks/${DEFAULTS.runningTask.id}/base`).send({});
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/tasks/:id/agents ──────────────────────────────────────────────

describe('POST /api/tasks/:id/agents', () => {
  // ─── Status gating (table-driven) ──────────────────────────────────────

  const nonRunningStates = ['idle', 'setting_up', 'error'];

  it.each(nonRunningStates)('returns 400 when task runtime_state is %s', async (state) => {
    insertTask(db, { runtime_state: state as any });
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

    expect(vi.mocked(addAgent).mock.calls[0][1]).toMatchObject({
      prompt: 'Write comprehensive tests',
    });
  });

  it('works without prompt', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/agents`).send({});
    expect(res.status).toBe(201);
    expect(vi.mocked(addAgent).mock.calls[0][1]).toMatchObject({ prompt: undefined });
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
    insertTask(db, { tmux_session: null, runtime_state: 'running' });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tmux');
  });

  const nonRunningStates = ['idle', 'setting_up', 'error'] as const;

  it.each(nonRunningStates)('returns 400 when task runtime_state is %s', async (state) => {
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: state });
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
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', harness_session_id: 'sess-1' });
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
    insertTask(db, { id: 't1', runtime_state: 'running' });
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
      insertTask(db, { id: 't1', runtime_state: 'running' });
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
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'idle' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBe('done');
  });

  it('derived_status is done when task has no agents', async () => {
    insertTask(db, { id: 't1', runtime_state: 'running' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBe('done');
  });

  it('derived_status ignores stopped agents in activity calculation', async () => {
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'stopped', hook_activity: 'active' });
    insertAgent(db, { id: 'a2', task_id: 't1', window_index: 1, hook_activity: 'waiting' });

    const res = await request(app).get('/api/tasks').expect(200);
    // Stopped agent's 'active' is ignored; only running agent's 'waiting' counts
    expect(res.body[0].derived_status).toBe('needs_attention');
  });

  it('derived_status is null for non-running tasks', async () => {
    insertTask(db, { id: 't1', runtime_state: 'idle' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBeNull();
  });

  it('includes pending_prompts in single task response', async () => {
    insertTask(db, { id: 't1', runtime_state: 'running' });
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

    const sendKeysCalls = vi
      .mocked(execFileMock)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
      );

    expect(sendKeysCalls).toHaveLength(2);

    const firstArgs = sendKeysCalls[0][1] as string[];
    expect(firstArgs).toContain('-t');
    expect(firstArgs).toContain(
      `${DEFAULTS.runningTask.tmux_session}:${DEFAULTS.agent.window_index}`,
    );
    expect(firstArgs).toContain('-l');
    expect(firstArgs).toContain('hello agent');
    expect(firstArgs).not.toContain('Enter');

    const secondArgs = sendKeysCalls[1][1] as string[];
    expect(secondArgs).toContain('-t');
    expect(secondArgs).toContain(
      `${DEFAULTS.runningTask.tmux_session}:${DEFAULTS.agent.window_index}`,
    );
    expect(secondArgs).toContain('Enter');
    expect(secondArgs).not.toContain('-l');
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
    insertTask(db, { runtime_state: 'idle' });
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
      defaultHarnessId: 'claude-code',
      harnesses: {},
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
      defaultHarnessId: 'claude-code',
      harnesses: {},
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

  it('GET /api/chats lists standalone agents in creation order', async () => {
    const a = await request(app).post('/api/chats').send({ label: 'Chat A' });
    const res = await request(app).get('/api/chats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(a.body.id);
  });

  it('POST /api/chats accepts an agent name and persists it on the row', async () => {
    const res = await request(app)
      .post('/api/chats')
      .send({ label: 'Run as orchestrator', agent: 'orchestrator' });
    expect(res.status).toBe(201);
    expect(res.body.agent).toBe('orchestrator');
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

  it("PATCH /api/chats/:id with status='stopped' closes the chat", async () => {
    const created = await request(app).post('/api/chats').send({ label: 'To close' });
    const id = created.body.id as string;

    const res = await request(app).patch(`/api/chats/${id}`).send({ status: 'stopped' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');

    const fetched = await request(app).get(`/api/chats/${id}`);
    expect(fetched.body.status).toBe('stopped');
  });

  it('PATCH /api/chats/:id rejects unsupported status values', async () => {
    const created = await request(app).post('/api/chats').send({ label: 'Bad patch' });
    const res = await request(app)
      .patch(`/api/chats/${created.body.id}`)
      .send({ status: 'running' });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/chats/:id returns 404 for unknown id', async () => {
    const res = await request(app).patch('/api/chats/missing').send({ status: 'stopped' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/chats/:id removes the chat row', async () => {
    const created = await request(app).post('/api/chats').send({ label: 'To delete' });
    const id = created.body.id as string;

    const del = await request(app).delete(`/api/chats/${id}`);
    expect(del.status).toBe(204);

    const fetched = await request(app).get(`/api/chats/${id}`);
    expect(fetched.status).toBe(404);
  });

  it('DELETE /api/chats/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/chats/missing');
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
    insertTask(db, { id: 'tX', worktree_id: 'wt1', runtime_state: 'running' });

    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('wt1');
    expect(res.body[0].task_count).toBe(1);
    expect(res.body[0].active_task_id).toBe('tX');
  });

  it('collapses worktree rows that share repo_path/mode/branch/path', async () => {
    // Three none-mode rows on the same physical workspace, accumulated over
    // three task lifecycles. Workspaces page should show ONE entry, not three.
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status, created_at, last_used_at)
       VALUES
         ('wtA','/tmp/repo','/tmp/repo','main','main','none','available','2026-01-01 00:00:00','2026-01-01 00:00:00'),
         ('wtB','/tmp/repo','/tmp/repo','main','main','none','available','2026-01-02 00:00:00','2026-01-02 00:00:00'),
         ('wtC','/tmp/repo','/tmp/repo','main','main','none','in_use',   '2026-01-03 00:00:00','2026-01-03 00:00:00')`,
    ).run();
    insertTask(db, {
      id: 'tA',
      worktree_id: 'wtA',
      runtime_state: 'idle',
      updated_at: '2026-01-01 00:00:00',
    });
    insertTask(db, {
      id: 'tB',
      worktree_id: 'wtB',
      runtime_state: 'idle',
      updated_at: '2026-01-02 00:00:00',
    });
    insertTask(db, {
      id: 'tC',
      worktree_id: 'wtC',
      runtime_state: 'running',
      updated_at: '2026-01-03 00:00:00',
    });

    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    // Picks the most-recent row as the representative id (so detail nav
    // lands on the active/freshest task).
    expect(row.id).toBe('wtC');
    // Aggregates across the group.
    expect(row.task_count).toBe(3);
    expect(row.status).toBe('in_use');
    expect(row.active_task_id).toBe('tC');
  });

  it('keeps worktree rows separate when they differ on the group key', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES
         ('wtMain','/tmp/repo','/tmp/repo','main','none','available'),
         ('wtFeat','/tmp/repo','/tmp/repo','feature-x','none','available')`,
    ).run();
    insertTask(db, { id: 't1', worktree_id: 'wtMain', runtime_state: 'idle' });
    insertTask(db, { id: 't2', worktree_id: 'wtFeat', runtime_state: 'idle' });

    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('hides orphan worktree rows that no task references', async () => {
    // Leftover from buggy code paths (e.g. resolved review-draft cleanup).
    // They have no task pointing at them and shouldn't pollute the UI.
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wtOrphan','','','','new','available')`,
    ).run();

    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
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
    insertTask(db, { id: 'tActive', worktree_id: 'wtD1', runtime_state: 'running' });
    insertTask(db, {
      id: 'tClosed',
      worktree_id: 'wtD1',
      runtime_state: 'idle',
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
    insertTask(db, { id: 'tX', worktree_id: 'wtD2', runtime_state: 'idle' });

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
    insertTask(db, { id: 'tRun', worktree_id: 'wtA1', runtime_state: 'running' });

    const res = await request(app).delete('/api/worktrees/wtA1');
    expect(res.status).toBe(409);
  });

  it('deletes row when available with no active tasks', async () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status) VALUES ('wtOK','/tmp/wtOK','existing','available')`,
    ).run();
    insertTask(db, { id: 'tTerm', worktree_id: 'wtOK', runtime_state: 'idle' });

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
    const res = await request(app).patch('/api/agents/missing/task').send({ task_id: null });
    expect(res.status).toBe(404);
  });

  it('400 when body missing task_id key', async () => {
    insertAgent(db, { id: 'aBody', task_id: null });
    const res = await request(app).patch('/api/agents/aBody/task').send({});
    expect(res.status).toBe(400);
  });

  it('400 when task_id equals current task_id (no-op)', async () => {
    insertTask(db, { id: 'tSame', runtime_state: 'running' });
    insertAgent(db, { id: 'aSame', task_id: 'tSame' });
    const res = await request(app).patch('/api/agents/aSame/task').send({ task_id: 'tSame' });
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
    insertTask(db, { id: 'tClosed', runtime_state: 'idle' });
    insertAgent(db, { id: 'aC', task_id: null });
    const res = await request(app).patch('/api/agents/aC/task').send({ task_id: 'tClosed' });
    expect(res.status).toBe(409);
  });

  it('detaches to standalone (task_id=null)', async () => {
    insertTask(db, { id: 'tFrom', runtime_state: 'running' });
    insertAgent(db, { id: 'aDet', task_id: 'tFrom' });

    const res = await request(app).patch('/api/agents/aDet/task').send({ task_id: null });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBeNull();
    expect(res.body.tmux_session).toBe('octomux-chat-aDet');
  });

  it('moves between tasks', async () => {
    insertTask(db, { id: 'tA', runtime_state: 'running' });
    insertTask(db, { id: 'tB', runtime_state: 'running' });
    insertAgent(db, { id: 'aMove', task_id: 'tA' });

    const res = await request(app).patch('/api/agents/aMove/task').send({ task_id: 'tB' });
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('tB');
  });

  it('attaches a standalone chat agent to a task', async () => {
    insertTask(db, { id: 'tTarget', runtime_state: 'running' });
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

// ─── GET /api/preflight/none-mode ────────────────────────────────────────────

describe('GET /api/preflight/none-mode', () => {
  it('400s when repo_path is missing', async () => {
    const res = await request(app).get('/api/preflight/none-mode?base_branch=main');
    expect(res.status).toBe(400);
  });

  it('400s when base_branch is missing', async () => {
    const res = await request(app).get('/api/preflight/none-mode?repo_path=/r');
    expect(res.status).toBe(400);
  });

  it('returns 400 from execFile failure on a fake repo path', async () => {
    const res = await request(app).get(
      '/api/preflight/none-mode?repo_path=/tmp/octomux-not-a-repo&base_branch=main',
    );
    // Fake repo path will surface as 400 from execFile failure. We just want to
    // confirm the route exists and delegates correctly.
    expect([200, 400]).toContain(res.status);
    expect(res.status).not.toBe(404);
  });
});

// ─── POST /api/preflight/stash ────────────────────────────────────────────────

describe('POST /api/preflight/stash', () => {
  it('400s when repo_path is missing', async () => {
    const res = await request(app)
      .post('/api/preflight/stash')
      .send({ target_branch: 'feature-x' });
    expect(res.status).toBe(400);
  });

  it('400s when target_branch is missing', async () => {
    const res = await request(app).post('/api/preflight/stash').send({ repo_path: '/r' });
    expect(res.status).toBe(400);
  });

  it('returns 400 from execFile failure on a fake repo path', async () => {
    const res = await request(app)
      .post('/api/preflight/stash')
      .send({ repo_path: '/tmp/octomux-not-a-repo', target_branch: 'feature-x' });
    expect([200, 400]).toContain(res.status);
    expect(res.status).not.toBe(404);
  });
});

describe('agent name validation', () => {
  const invalidAgentCases = [
    { name: 'semicolon injection', agent: 'foo; rm -rf /' },
    { name: 'space in name', agent: 'has space' },
    { name: 'path traversal', agent: '../etc/passwd' },
    { name: 'slash', agent: 'some/path' },
    { name: 'empty string', agent: '' },
    { name: 'null byte', agent: 'foo\0bar' },
  ];

  describe('POST /api/tasks', () => {
    it.each(invalidAgentCases)('rejects $name as agent → 400', async ({ agent }) => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'T', description: 'D', repo_path: '/tmp', agent });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid agent name/);
    });
  });

  describe('POST /api/tasks/:id/agents', () => {
    it.each(invalidAgentCases)('rejects $name as agent → 400', async ({ agent }) => {
      insertTask(db, { ...DEFAULTS.runningTask });
      const res = await request(app)
        .post(`/api/tasks/${DEFAULTS.runningTask.id}/agents`)
        .send({ agent });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid agent name/);
    });
  });

  describe('POST /api/chats', () => {
    it.each(invalidAgentCases)('rejects $name as agent → 400', async ({ agent }) => {
      const res = await request(app).post('/api/chats').send({ agent });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid agent name/);
    });
  });

  describe('GET /api/harnesses', () => {
    it('returns registered harnesses with id, displayName, sessionIdMode', async () => {
      const res = await request(app).get('/api/harnesses');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'claude-code',
            displayName: 'Claude Code',
            sessionIdMode: 'orchestrator-assigned',
          }),
          expect.objectContaining({
            id: 'cursor',
            displayName: 'Cursor',
            sessionIdMode: 'harness-issued',
          }),
        ]),
      );
    });
  });

  describe('POST /api/tasks with harness_id', () => {
    it('accepts harness_id: "cursor" and persists it', async () => {
      const res = await request(app).post('/api/tasks').send({
        title: 'Cursor task',
        description: 'd',
        repo_path: '/tmp/x',
        harness_id: 'cursor',
        draft: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.harness_id).toBe('cursor');
    });

    it('defaults to claude-code when harness_id is omitted', async () => {
      const res = await request(app).post('/api/tasks').send({
        title: 'Default task',
        description: 'd',
        repo_path: '/tmp/x',
        draft: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.harness_id).toBe('claude-code');
    });

    it('rejects unknown harness_id with 400', async () => {
      const res = await request(app).post('/api/tasks').send({
        title: 'Bad task',
        description: 'd',
        repo_path: '/tmp/x',
        harness_id: 'not-a-real-harness',
        draft: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown harness/);
    });
  });
});
