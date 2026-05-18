import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, getTask } from './test-helpers.js';
import { createApp } from './app.js';

// ─── Title-gen mock ───────────────────────────────────────────────────────────

// title-gen: not mocked here; tests rely on fallback behavior (no ANTHROPIC_API_KEY in test env)

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-runner.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    startTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET runtime_state = 'running', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    }),
    closeTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(`UPDATE agents SET status = 'stopped' WHERE task_id = ?`).run(task.id);
    }),
    deleteTask: vi.fn(),
    resumeTask: vi.fn(),
    addAgent: vi.fn(),
    stopAgent: vi.fn(),
    createUserTerminal: vi.fn(),
    createShellTerminal: vi.fn(),
    closeShellTerminal: vi.fn(),
    hopAgent: vi.fn(),
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

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

vi.mock('./title-gen.js', () => ({
  generateTitleAndDescription: vi.fn(async (prompt: string) => ({
    title: prompt.split('\n')[0]?.slice(0, 50) ?? 'Untitled task',
    description: prompt,
  })),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/tasks/archive-done', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('returns { archived: 0 } when no done tasks exist', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress' });
    const res = await request(app).post('/api/tasks/archive-done').expect(200);
    expect(res.body).toEqual({ archived: 0 });
  });

  it('archives all done tasks and writes task_updates rows', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });
    insertTask(db, { id: 't2', workflow_status: 'done', runtime_state: 'idle' });
    insertTask(db, { id: 't3', workflow_status: 'in_progress', runtime_state: 'running' });

    const res = await request(app).post('/api/tasks/archive-done').expect(200);
    expect(res.body).toEqual({ archived: 2 });

    const t1 = getTask(db, 't1');
    const t2 = getTask(db, 't2');
    const t3 = getTask(db, 't3');
    expect(t1?.workflow_status).toBe('archived');
    expect(t2?.workflow_status).toBe('archived');
    expect(t3?.workflow_status).toBe('in_progress'); // untouched

    const updates = db
      .prepare(`SELECT * FROM task_updates WHERE task_id IN ('t1','t2') ORDER BY created_at ASC`)
      .all() as any[];
    expect(updates).toHaveLength(2);
    expect(updates[0].from_status).toBe('done');
    expect(updates[0].to_status).toBe('archived');
    expect(updates[0].body).toBe('auto: bulk archive');
  });

  it('calls closeTask for done tasks that are running before archiving', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'running' });

    const { closeTask } = await import('./task-runner.js');

    const res = await request(app).post('/api/tasks/archive-done').expect(200);
    expect(res.body).toEqual({ archived: 1 });
    expect(closeTask).toHaveBeenCalledTimes(1);
    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('does not call closeTask for done tasks that are idle', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });

    const { closeTask } = await import('./task-runner.js');

    await request(app).post('/api/tasks/archive-done').expect(200);
    expect(closeTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/move to archived (B2)', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('calls closeTask before archiving a running task', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'running' });

    const { closeTask } = await import('./task-runner.js');

    const res = await request(app)
      .post('/api/tasks/t1/move')
      .send({ workflow_status: 'archived' })
      .expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    expect(res.body.workflow_status).toBe('archived');
  });

  it('does not call closeTask when archiving an idle task', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });

    const { closeTask } = await import('./task-runner.js');

    await request(app).post('/api/tasks/t1/move').send({ workflow_status: 'archived' }).expect(200);

    expect(closeTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/move to done', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('calls closeTask when moving a running task to done', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'running' });

    const { closeTask } = await import('./task-runner.js');

    const res = await request(app)
      .post('/api/tasks/t1/move')
      .send({ workflow_status: 'done' })
      .expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    expect(res.body.workflow_status).toBe('done');
  });

  it('calls closeTask when moving a setting_up task to done', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress', runtime_state: 'setting_up' });

    const { closeTask } = await import('./task-runner.js');

    await request(app).post('/api/tasks/t1/move').send({ workflow_status: 'done' }).expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('does not call closeTask when moving an idle task to done', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress', runtime_state: 'idle' });

    const { closeTask } = await import('./task-runner.js');

    await request(app).post('/api/tasks/t1/move').send({ workflow_status: 'done' }).expect(200);

    expect(closeTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks createTask with title-gen (B5)', () => {
  let _db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    _db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('fills description from initial_prompt when description is not provided', async () => {
    // When no description is provided, the server derives it from initial_prompt
    // (via generateTitleAndDescription fallback or real generation).
    const prompt = 'Build a login page with OAuth support';
    const res = await request(app)
      .post('/api/tasks')
      .send({
        title: 'My fallback title',
        initial_prompt: prompt,
        run_mode: 'scratch',
        draft: true,
      })
      .expect(201);

    // The task must have a non-empty description derived from the prompt
    expect(res.body.description).toBeTruthy();
    expect(res.body.title).toBeTruthy();
    // Without ANTHROPIC_API_KEY (test env), the fallback uses the raw prompt
    expect(res.body.description).toBe(prompt);
  });

  it('uses client title and description as-is when both are provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({
        title: 'Explicit title',
        description: 'Explicit description',
        initial_prompt: 'Build a login page',
        run_mode: 'scratch',
        draft: true,
      })
      .expect(201);

    expect(res.body.title).toBe('Explicit title');
    expect(res.body.description).toBe('Explicit description');
  });

  it('rejects when neither title/description nor initial_prompt is provided', async () => {
    await request(app)
      .post('/api/tasks')
      .send({
        run_mode: 'scratch',
        draft: true,
      })
      .expect(400);
  });
});
