import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, getTask } from './test-helpers.js';
import { createApp } from './app.js';

// ─── Title-gen mock ───────────────────────────────────────────────────────────

// title-gen: not mocked here; tests rely on fallback behavior (no ANTHROPIC_API_KEY in test env)

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-engine/index.js', async () => {
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
    softDeleteTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET deleted_at = datetime('now'), runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
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

describe('POST /api/tasks/delete-done', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('returns { deleted: 0 } when no done tasks exist', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress' });
    const res = await request(app).post('/api/tasks/delete-done').expect(200);
    expect(res.body).toEqual({ deleted: 0 });
  });

  it('soft-deletes all done tasks (sets deleted_at, keeps workflow_status = done)', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });
    insertTask(db, { id: 't2', workflow_status: 'done', runtime_state: 'idle' });
    insertTask(db, { id: 't3', workflow_status: 'in_progress', runtime_state: 'running' });

    const res = await request(app).post('/api/tasks/delete-done').expect(200);
    expect(res.body).toEqual({ deleted: 2 });

    const t1 = getTask(db, 't1');
    const t2 = getTask(db, 't2');
    const t3 = getTask(db, 't3');
    expect(t1?.workflow_status).toBe('done'); // status stays done
    expect(t2?.workflow_status).toBe('done');
    expect(t3?.workflow_status).toBe('in_progress'); // untouched

    // Verify deleted_at via raw query since Task type / SELECT_TASK_SQL doesn't include it
    const row1 = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get('t1') as any;
    const row2 = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get('t2') as any;
    const row3 = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get('t3') as any;
    expect(row1.deleted_at).not.toBeNull(); // soft-deleted
    expect(row2.deleted_at).not.toBeNull(); // soft-deleted
    expect(row3.deleted_at).toBeNull(); // not deleted
  });

  it('does not re-delete tasks already soft-deleted', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });
    // First call soft-deletes t1
    const first = await request(app).post('/api/tasks/delete-done').expect(200);
    expect(first.body).toEqual({ deleted: 1 });
    // Second call should find 0 eligible tasks (deleted_at IS NOT NULL now)
    const second = await request(app).post('/api/tasks/delete-done').expect(200);
    expect(second.body).toEqual({ deleted: 0 });
  });

  it('kills sessions via task-engine softDeleteTask for done tasks that are running', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', status: 'running' });

    const { softDeleteTask } = await import('./task-engine/index.js');

    const res = await request(app).post('/api/tasks/delete-done').expect(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect(softDeleteTask).toHaveBeenCalledTimes(1);
    expect(softDeleteTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('kills sessions via task-engine softDeleteTask for done tasks that are idle', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });

    const { softDeleteTask } = await import('./task-engine/index.js');

    await request(app).post('/api/tasks/delete-done').expect(200);
    expect(softDeleteTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
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

    const { closeTask } = await import('./task-engine/index.js');

    const res = await request(app)
      .post('/api/tasks/t1/move')
      .send({ workflow_status: 'done' })
      .expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    expect(res.body.workflow_status).toBe('done');
  });

  it('calls closeTask when moving a setting_up task to done', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress', runtime_state: 'setting_up' });

    const { closeTask } = await import('./task-engine/index.js');

    await request(app).post('/api/tasks/t1/move').send({ workflow_status: 'done' }).expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('calls closeTask when moving an idle task to done (idle agents still hold sessions)', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress', runtime_state: 'idle' });

    const { closeTask } = await import('./task-engine/index.js');

    await request(app).post('/api/tasks/t1/move').send({ workflow_status: 'done' }).expect(200);

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('does not call closeTask when the task is already done (re-move is a no-op)', async () => {
    insertTask(db, { id: 't1', workflow_status: 'done', runtime_state: 'idle' });

    const { closeTask } = await import('./task-engine/index.js');

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
