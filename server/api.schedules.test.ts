import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { upsertSchedule } from './repositories/schedules.js';
import { insertRun } from './repositories/runs.js';

describe('schedule routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  describe('GET /api/schedules/kinds', () => {
    it('lists registered schedule kinds', async () => {
      const res = await request(app).get('/api/schedules/kinds');
      expect(res.status).toBe(200);
      const kinds = res.body.kinds.map((k: { kind: string }) => k.kind);
      expect(kinds).toContain('prod-log-triage');
      expect(kinds).toContain('doc-drift');
      expect(kinds).toContain('weekly-update');
      expect(kinds).toContain('daily-plan');
    });
  });

  describe('GET /api/schedules', () => {
    it('lists all schedules, enabled and disabled', async () => {
      upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo-a', cron: '0 7 * * *' });
      upsertSchedule({
        kind: 'prod-log-triage',
        repoPath: '/repo-b',
        cron: '0 8 * * *',
        enabled: false,
      });

      const res = await request(app).get('/api/schedules');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('POST /api/schedules', () => {
    it('creates a schedule and returns 201', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

      expect(res.status).toBe(201);
      expect(res.body.kind).toBe('prod-log-triage');
      expect(res.body.repo_path).toBe('/repo');
      expect(res.body.enabled).toBe(1);
    });

    it('accepts enabled=false and a config blob', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({
          kind: 'prod-log-triage',
          repoPath: '/repo',
          cron: '0 7 * * *',
          enabled: false,
          config: { logCommand: 'flyctl logs -a my-app' },
        });

      expect(res.status).toBe(201);
      expect(res.body.enabled).toBe(0);
      expect(JSON.parse(res.body.config_json)).toEqual({ logCommand: 'flyctl logs -a my-app' });
    });

    it('rejects an unknown kind with 400', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'not-a-real-kind', repoPath: '/repo', cron: '0 7 * * *' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing repoPath with 400', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', cron: '0 7 * * *' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing cron with 400', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', repoPath: '/repo' });
      expect(res.status).toBe(400);
    });

    it('rejects a blank cron with 400', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', repoPath: '/repo', cron: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/schedules/:id', () => {
    it('updates cron/enabled/config and returns 200', async () => {
      const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

      const res = await request(app)
        .patch(`/api/schedules/${row.id}`)
        .send({ cron: '0 8 * * *', enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.cron).toBe('0 8 * * *');
      expect(res.body.enabled).toBe(0);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app)
        .patch('/api/schedules/does-not-exist')
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });

    it('rejects a blank cron with 400', async () => {
      const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ cron: '  ' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/schedules/:id', () => {
    it('deletes a schedule and returns 204', async () => {
      const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });

      const res = await request(app).delete(`/api/schedules/${row.id}`);
      expect(res.status).toBe(204);

      const listRes = await request(app).get('/api/schedules');
      expect(listRes.body).toHaveLength(0);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).delete('/api/schedules/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/schedules/:id/runs', () => {
    it('returns runs stamped with this schedule id from the runs table', async () => {
      const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
      insertRun({
        workflowKind: 'weekly-update',
        trigger: 'manual',
        scheduleId: row.id,
      });
      insertRun({
        workflowKind: 'prod-log-triage',
        trigger: 'cron',
        scheduleId: 'other-schedule',
      });

      const res = await request(app).get(`/api/schedules/${row.id}/runs`);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].workflow_kind).toBe('weekly-update');
      expect(res.body.runs[0].schedule_id).toBe(row.id);
    });

    it('returns 404 for an unknown schedule id', async () => {
      const res = await request(app).get('/api/schedules/does-not-exist/runs');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/schedules/:id/run', () => {
    it('triggers a manual run via executeScheduleRun', async () => {
      const row = upsertSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });

      const res = await request(app).post(`/api/schedules/${row.id}/run`);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
    });

    it('returns 404 for an unknown schedule id', async () => {
      const res = await request(app).post('/api/schedules/does-not-exist/run');
      expect(res.status).toBe(404);
    });
  });
});
