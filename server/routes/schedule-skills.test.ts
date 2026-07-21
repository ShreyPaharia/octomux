import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createTestDb } from '../test-helpers.js';
import { getScheduleSkillRow } from '../repositories/schedule-skills.js';

describe('schedule-skills routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  describe('GET /api/schedule-skills', () => {
    it('returns a body for every cron kind, seeding from the shipped default', async () => {
      const res = await request(app).get('/api/schedule-skills');
      expect(res.status).toBe(200);
      const kinds = res.body.map((s: { kind: string }) => s.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'doc-drift',
          'prod-log-triage',
          'weekly-update',
          'overnight-log-summary',
          'daily-plan',
        ]),
      );
      for (const skill of res.body) {
        expect(typeof skill.content).toBe('string');
        expect(skill.content.length).toBeGreaterThan(0);
      }
      // GET is a read that seeds the DB.
      expect(getScheduleSkillRow('doc-drift')).toBeDefined();
    });
  });

  describe('PUT /api/schedule-skills/:kind', () => {
    it('persists the edited body', async () => {
      const res = await request(app)
        .put('/api/schedule-skills/doc-drift')
        .send({ content: 'Edited body' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: 'doc-drift', content: 'Edited body' });
      expect(getScheduleSkillRow('doc-drift')?.content).toBe('Edited body');
    });

    it('rejects blank content with 400', async () => {
      const res = await request(app).put('/api/schedule-skills/doc-drift').send({ content: '  ' });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown kind with 404', async () => {
      const res = await request(app).put('/api/schedule-skills/not-a-kind').send({ content: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/schedule-skills/:kind', () => {
    it('resets the body so the next read re-seeds from the shipped default', async () => {
      await request(app).put('/api/schedule-skills/doc-drift').send({ content: 'Edited body' });

      const del = await request(app).delete('/api/schedule-skills/doc-drift');
      expect(del.status).toBe(204);
      expect(getScheduleSkillRow('doc-drift')).toBeUndefined();
    });

    it('rejects an unknown kind with 404', async () => {
      const res = await request(app).delete('/api/schedule-skills/not-a-kind');
      expect(res.status).toBe(404);
    });
  });
});
