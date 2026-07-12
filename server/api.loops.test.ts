import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createLoopRun, appendIteration } from './repositories/loop-runs.js';

describe('loop routes', () => {
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 't1', runtime_state: 'looping' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-loop' } as any);
  });

  describe('POST /api/loops/:runId/emit', () => {
    it('persists a valid emit and returns 200', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'all good' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('done');
      expect(res.body.termination_reason).toBe('all good');

      const iteration = db
        .prepare(`SELECT emit_status, emit_reason FROM loop_iterations WHERE loop_run_id = ?`)
        .get(run.id) as { emit_status: string; emit_reason: string };
      expect(iteration.emit_status).toBe('done');
      expect(iteration.emit_reason).toBe('all good');
    });

    it('rejects an invalid status enum with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'finished', reason: 'x' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing reason with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done' });

      expect(res.status).toBe(400);
    });

    it('rejects a blank reason with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: '   ' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing token with 401', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(401);
    });

    it('rejects an unrecognized token with 401', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer nope')
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app)
        .post(`/api/loops/does-not-exist/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/loops', () => {
    it('lists loop runs', async () => {
      createLoopRun({ task_id: 't1', spec_json: '{}' });
      createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app).get('/api/loops');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('GET /api/loops/:runId', () => {
    it('returns the run with its iterations', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });
      appendIteration(run.id, { sha_from: 'a2', sha_to: 'a3' });

      const res = await request(app).get(`/api/loops/${run.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(run.id);
      expect(res.body.iterations).toHaveLength(2);
      expect(res.body.iterations[0].n).toBe(1);
      expect(res.body.iterations[1].n).toBe(2);
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app).get('/api/loops/does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
