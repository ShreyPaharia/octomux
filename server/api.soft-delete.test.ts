import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask } from './test-helpers.js';
import { createApp } from './app.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-runner.js', async () => {
  const { getDb } = await import('./db.js');
  return {
    startTask: vi.fn(),
    closeTask: vi.fn(),
    softDeleteTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET deleted_at = datetime('now'),
                          runtime_state = 'idle',
                          updated_at = datetime('now')
           WHERE id = ?`,
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

describe('DELETE /api/tasks/:id (soft delete)', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('soft-deletes by default (sets deleted_at, does not drop row)', async () => {
    insertTask(db, { id: 't1', workflow_status: 'in_progress' });
    await request(app).delete('/api/tasks/t1').expect(204);
    const row = db.prepare(`SELECT deleted_at FROM tasks WHERE id = 't1'`).get() as any;
    expect(row?.deleted_at).not.toBeNull();
  });

  it('?purge=true hard-deletes when already soft-deleted', async () => {
    insertTask(db, { id: 't1' });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't1'`).run();
    await request(app).delete('/api/tasks/t1?purge=true').expect(204);
    expect(db.prepare(`SELECT id FROM tasks WHERE id = 't1'`).get()).toBeUndefined();
  });

  it('?purge=true on a live task returns 409', async () => {
    insertTask(db, { id: 't1' });
    const res = await request(app).delete('/api/tasks/t1?purge=true').expect(409);
    expect(res.body.error).toMatch(/soft-deleted/);
  });
});

describe('POST /api/tasks/:id/restore', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('clears deleted_at on a soft-deleted task', async () => {
    insertTask(db, { id: 't1' });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't1'`).run();
    await request(app).post('/api/tasks/t1/restore').expect(200);
    const row = db.prepare(`SELECT deleted_at FROM tasks WHERE id = 't1'`).get() as any;
    expect(row.deleted_at).toBeNull();
  });

  it('returns 409 on a live task', async () => {
    insertTask(db, { id: 't1' });
    await request(app).post('/api/tasks/t1/restore').expect(409);
  });
});

describe('GET /api/tasks trash filtering', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  it('excludes soft-deleted tasks by default', async () => {
    insertTask(db, { id: 't1' });
    insertTask(db, { id: 't2' });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't2'`).run();
    const res = await request(app).get('/api/tasks').expect(200);
    const ids = (res.body as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t2');
  });

  it('returns only soft-deleted with ?trash=true', async () => {
    insertTask(db, { id: 't1' });
    insertTask(db, { id: 't2' });
    db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't2'`).run();
    const res = await request(app).get('/api/tasks?trash=true').expect(200);
    const ids = (res.body as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain('t1');
    expect(ids).toContain('t2');
  });
});
