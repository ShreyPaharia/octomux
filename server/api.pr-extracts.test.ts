import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';

describe('POST /api/pr-extracts/:taskId/emit', () => {
  let app: ReturnType<typeof createApp>;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  const validBody = {
    area: 'server',
    risk: 'low',
    has_migration: false,
    surface: 'api',
    loc: 42,
  };

  function seed() {
    insertTask(db, { id: 'task-1', source: 'pr_extract', pr_number: 7, pr_head_sha: 'sha-1' });
    insertAgent(db, { id: 'agent-1', task_id: 'task-1', hook_token: 'tok-1' });
  }

  it('401s with no bearer token', async () => {
    seed();
    const res = await request(app).post('/api/pr-extracts/task-1/emit').send(validBody);
    expect(res.status).toBe(401);
  });

  it('401s with an invalid bearer token', async () => {
    seed();
    const res = await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer wrong-token')
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it('404s for an unknown task', async () => {
    seed();
    const res = await request(app)
      .post('/api/pr-extracts/no-such-task/emit')
      .set('Authorization', 'Bearer tok-1')
      .send(validBody);
    expect(res.status).toBe(404);
  });

  it('400s when the task has no PR metadata', async () => {
    insertTask(db, { id: 'task-no-pr', source: 'pr_extract', pr_number: null, pr_head_sha: null });
    insertAgent(db, { id: 'agent-no-pr', task_id: 'task-no-pr', hook_token: 'tok-no-pr' });
    const res = await request(app)
      .post('/api/pr-extracts/task-no-pr/emit')
      .set('Authorization', 'Bearer tok-no-pr')
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it('400s on a schema violation (missing required field)', async () => {
    seed();
    const { risk: _risk, ...rest } = validBody;
    const res = await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer tok-1')
      .send(rest);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/risk/);
  });

  it('400s on an out-of-enum risk value', async () => {
    seed();
    const res = await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer tok-1')
      .send({ ...validBody, risk: 'extreme' });
    expect(res.status).toBe(400);
  });

  it('201s and persists a valid payload', async () => {
    seed();
    const res = await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer tok-1')
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.task_id).toBe('task-1');
    expect(res.body.pr_number).toBe(7);
    expect(res.body.has_migration).toBe(false);

    const getRes = await request(app).get(`/api/pr-extracts/${res.body.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.area).toBe('server');
  });

  it('409s when emitting twice for the same task', async () => {
    seed();
    await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer tok-1')
      .send(validBody);
    const res = await request(app)
      .post('/api/pr-extracts/task-1/emit')
      .set('Authorization', 'Bearer tok-1')
      .send(validBody);
    expect(res.status).toBe(409);
  });
});

describe('GET /api/pr-extracts', () => {
  it('lists created extracts', async () => {
    const db = createTestDb();
    const app = createApp();
    insertTask(db, { id: 'task-2', source: 'pr_extract', pr_number: 8, pr_head_sha: 'sha-2' });
    insertAgent(db, { id: 'agent-2', task_id: 'task-2', hook_token: 'tok-2' });
    await request(app)
      .post('/api/pr-extracts/task-2/emit')
      .set('Authorization', 'Bearer tok-2')
      .send({ area: 'cli', risk: 'high', has_migration: true, surface: 'cli', loc: 9 });
    const res = await request(app).get('/api/pr-extracts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('404s GET /api/pr-extracts/:id for an unknown id', async () => {
    createTestDb();
    const app = createApp();
    const res = await request(app).get('/api/pr-extracts/no-such-id');
    expect(res.status).toBe(404);
  });
});
