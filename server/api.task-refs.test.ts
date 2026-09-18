import { describe, it, expect, beforeEach, vi } from './bun-test.js';

vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn(),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(() => []),
}));

vi.mock('./events.js', () => ({
  broadcast: vi.fn(),
  setupWs: vi.fn(),
}));

const { default: request } = await import('supertest');
const { createTestDb, insertTask } = await import('./test-helpers.js');
const { getDb } = await import('./db.js');

const { createApp } = await import('./app.js');

async function createTestTask(): Promise<string> {
  const db = getDb();
  insertTask(db, { id: 'ref-task-01', title: 'Ref task', description: 'desc', worktree: null });
  return 'ref-task-01';
}

describe('GET /api/tasks?ref=', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('filters to the tasks carrying that ref, splitting on the FIRST colon', async () => {
    const app = createApp();
    const db = getDb();
    insertTask(db, { id: 'linked-01', title: 'Linked', description: 'd', worktree: null });
    insertTask(db, { id: 'other-01', title: 'Other', description: 'd', worktree: null });

    // A Slack ref is `<channel>:<ts>` — it contains a colon of its own, so a naive
    // split would look up integration 'slack' / ref 'C123' and find nothing.
    await request(app)
      .post('/api/tasks/linked-01/refs')
      .send({ integration: 'slack', ref: 'C123:1784893312.104219' })
      .expect(201);

    const hit = await request(app).get('/api/tasks?ref=slack:C123:1784893312.104219').expect(200);
    expect(hit.body.map((t: { id: string }) => t.id)).toEqual(['linked-01']);

    const miss = await request(app).get('/api/tasks?ref=slack:C123:0000000000.000000').expect(200);
    expect(miss.body).toEqual([]);
  });

  it('rejects a ref with no integration prefix', async () => {
    await request(createApp()).get('/api/tasks?ref=no-colon').expect(400);
  });
});

describe('POST /api/tasks/:id/refs metadata', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('accepts a metadata object and round-trips it', async () => {
    const app = createApp();
    const taskId = await createTestTask();

    const res = await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({
        integration: 'linear',
        ref: 'BAC-1',
        url: 'https://linear.app/x/issue/BAC-1',
        metadata: { team_key: 'BAC', team_id: 'uuid-1' },
      })
      .expect(201);

    expect(res.body.metadata).toEqual({ team_key: 'BAC', team_id: 'uuid-1' });

    const list = await request(app).get(`/api/tasks/${taskId}/refs`).expect(200);
    expect(list.body[0].metadata).toEqual({ team_key: 'BAC', team_id: 'uuid-1' });
  });

  it('rejects non-object metadata (array)', async () => {
    const app = createApp();
    const taskId = await createTestTask();

    await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'linear', ref: 'BAC-2', metadata: [1, 2] })
      .expect(400);
  });

  it('legacy POST without metadata returns metadata: null', async () => {
    const app = createApp();
    const taskId = await createTestTask();
    const res = await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'jira', ref: 'PROJ-1' })
      .expect(201);
    expect(res.body.metadata).toBeNull();
  });

  it('rejects non-object metadata (string)', async () => {
    const app = createApp();
    const taskId = await createTestTask();

    await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'linear', ref: 'BAC-3', metadata: 'bad' })
      .expect(400);
  });

  it('accepts null metadata explicitly and returns null', async () => {
    const app = createApp();
    const taskId = await createTestTask();

    const res = await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'linear', ref: 'BAC-4', metadata: null })
      .expect(201);
    expect(res.body.metadata).toBeNull();
  });
});

describe('GET /api/tasks/:id/refs metadata', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns parsed metadata for refs inserted directly with JSON string', async () => {
    const app = createApp();
    const taskId = await createTestTask();
    const db = getDb();
    db.prepare(
      `INSERT INTO task_external_refs (task_id, integration, ref, url, metadata, created_at)
       VALUES (?, 'linear', 'BAC-5', NULL, ?, datetime('now'))`,
    ).run(taskId, JSON.stringify({ team_key: 'BAC', team_id: 'uuid-5' }));

    const list = await request(app).get(`/api/tasks/${taskId}/refs`).expect(200);
    expect(list.body[0].metadata).toEqual({ team_key: 'BAC', team_id: 'uuid-5' });
  });

  it('returns metadata: null for legacy rows with NULL metadata', async () => {
    const app = createApp();
    const taskId = await createTestTask();
    const db = getDb();
    db.prepare(
      `INSERT INTO task_external_refs (task_id, integration, ref, created_at)
       VALUES (?, 'jira', 'PROJ-99', datetime('now'))`,
    ).run(taskId);

    const list = await request(app).get(`/api/tasks/${taskId}/refs`).expect(200);
    expect(list.body[0].metadata).toBeNull();
  });
});
