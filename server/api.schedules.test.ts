import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { createSchedule } from './repositories/schedules.js';
import { insertRun } from './repositories/runs.js';
import { upsertScheduleSkill } from './repositories/schedule-skills.js';
import { registerWorkflow } from './workflows/registry.js';

// Register a minimal 'custom' test workflow to exercise the custom-kind validation path.
// B3 will register this in production; this inline registration keeps the tests self-contained
// until that lands.
function ensureCustomWorkflowRegistered() {
  // Guard: if already registered (e.g. by B3 landing), skip.
  try {
    registerWorkflow({
      kind: 'custom',
      displayName: 'Custom Prompt',
      surfaces: ['artifact'],
      execution: 'session',
      trigger: { kind: 'cron' },
      run: async () => {},
    });
  } catch {
    // registerWorkflow overwrites silently (Map.set), so no throw expected
  }
}

describe('schedule routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    ensureCustomWorkflowRegistered();
    app = createApp();
  });

  // ── GET /api/schedules/kinds ────────────────────────────────────────────────

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

    it('includes execution, promptRequired, and supportsTimeout flags', async () => {
      const res = await request(app).get('/api/schedules/kinds');
      expect(res.status).toBe(200);

      const byKind = Object.fromEntries(res.body.kinds.map((k: { kind: string }) => [k.kind, k]));

      // session kind (weekly-update)
      if (byKind['weekly-update']) {
        expect(byKind['weekly-update'].execution).toBe('session');
        expect(byKind['weekly-update'].supportsTimeout).toBe(true);
        expect(byKind['weekly-update'].promptRequired).toBe(false);
      }

      // task kind (doc-drift)
      if (byKind['doc-drift']) {
        expect(byKind['doc-drift'].execution).toBe('task');
        expect(byKind['doc-drift'].supportsTimeout).toBe(false);
        expect(byKind['doc-drift'].promptRequired).toBe(false);
      }

      // chat kind (daily-plan)
      if (byKind['daily-plan']) {
        expect(byKind['daily-plan'].execution).toBe('chat');
        expect(byKind['daily-plan'].supportsTimeout).toBe(false);
        expect(byKind['daily-plan'].promptRequired).toBe(false);
      }

      // custom kind
      if (byKind['custom']) {
        expect(byKind['custom'].execution).toBe('session');
        expect(byKind['custom'].supportsTimeout).toBe(true);
        expect(byKind['custom'].promptRequired).toBe(true);
      }
    });
  });

  // ── GET /api/schedules ─────────────────────────────────────────────────────

  describe('GET /api/schedules', () => {
    it('lists all schedules, enabled and disabled', async () => {
      createSchedule({ kind: 'prod-log-triage', repoPath: '/repo-a', cron: '0 7 * * *' });
      createSchedule({
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

  // ── POST /api/schedules ────────────────────────────────────────────────────

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

    it('always returns 201 (no upsert — two POSTs with same kind+repo produce two rows)', async () => {
      const res1 = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
      const res2 = await request(app)
        .post('/api/schedules')
        .send({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 8 * * *' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.id).not.toBe(res2.body.id);

      const list = await request(app).get('/api/schedules');
      expect(list.body).toHaveLength(2);
    });

    it('accepts enabled=false', async () => {
      const res = await request(app).post('/api/schedules').send({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * *',
        enabled: false,
      });

      expect(res.status).toBe(201);
      expect(res.body.enabled).toBe(0);
    });

    it('accepts a config blob and stores it as config_json', async () => {
      // Use slack-watcher whose schema has no format:'single-line' fields
      const res = await request(app)
        .post('/api/schedules')
        .send({
          kind: 'slack-watcher',
          repoPath: '/repo',
          cron: '0 7 * * *',
          config: { slackUserId: 'U123', digestTarget: 'slack' },
        });

      expect(res.status).toBe(201);
      expect(JSON.parse(res.body.config_json)).toMatchObject({ slackUserId: 'U123' });
    });

    it('accepts optional name, timezone, model, timeoutMs, prompt', async () => {
      const res = await request(app).post('/api/schedules').send({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
        name: 'My Weekly',
        timezone: 'America/New_York',
        model: 'claude-opus-4-8',
        timeoutMs: 600000,
        prompt: 'do the thing',
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Weekly');
      expect(res.body.timezone).toBe('America/New_York');
      expect(res.body.model).toBe('claude-opus-4-8');
      expect(res.body.timeout_ms).toBe(600000);
      expect(res.body.prompt).toBe('do the thing');
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

    // ── Validation table ──────────────────────────────────────────────────────

    it.each([
      // [description, body patch, expected 400]
      ['bad cron expression', { cron: 'not-a-cron' }, true],
      ['bad cron with valid fields', { cron: '99 99 * * *' }, true],
      ['bad timezone (valid cron)', { cron: '0 7 * * *', timezone: 'Invalid/Zone' }, true],
      ['bad model (contains spaces)', { cron: '0 7 * * *', model: 'bad model name' }, true],
      ['bad model (too long)', { cron: '0 7 * * *', model: 'a'.repeat(129) }, true],
      ['bad model (has shell injection)', { cron: '0 7 * * *', model: 'model;rm -rf /' }, true],
      ['timeoutMs too small (9999)', { cron: '0 7 * * *', timeoutMs: 9999 }, true],
      ['timeoutMs too large (86_400_001)', { cron: '0 7 * * *', timeoutMs: 86_400_001 }, true],
      ['timeoutMs non-integer (float)', { cron: '0 7 * * *', timeoutMs: 30000.5 }, true],
      ['valid model passes', { cron: '0 7 * * *', model: 'claude-opus-4-8' }, false],
      ['valid timeoutMs passes (boundary min)', { cron: '0 7 * * *', timeoutMs: 10_000 }, false],
      [
        'valid timeoutMs passes (boundary max)',
        { cron: '0 7 * * *', timeoutMs: 86_400_000 },
        false,
      ],
    ])(
      'POST validation: %s',
      async (_desc: string, bodyPatch: Record<string, unknown>, expectBad: boolean) => {
        const body = {
          kind: 'weekly-update',
          repoPath: '/repo',
          cron: '0 7 * * *',
          ...bodyPatch,
        };
        const res = await request(app).post('/api/schedules').send(body);
        if (expectBad) {
          expect(res.status).toBe(400);
        } else {
          expect(res.status).toBe(201);
        }
      },
    );

    // ── custom kind validation ─────────────────────────────────────────────────

    it('rejects enabled custom schedule without prompt (400)', async () => {
      const res = await request(app)
        .post('/api/schedules')
        .send({ kind: 'custom', repoPath: '/repo', cron: '0 7 * * *', name: 'My Custom' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/prompt/i);
    });

    it('rejects enabled custom schedule without name (400)', async () => {
      const res = await request(app).post('/api/schedules').send({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        prompt: 'do something',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    it('accepts valid custom schedule with name and prompt (201)', async () => {
      const res = await request(app).post('/api/schedules').send({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        name: 'My Custom',
        prompt: 'do something useful',
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Custom');
      expect(res.body.prompt).toBe('do something useful');
    });

    it('allows disabled custom schedule without prompt or name (201)', async () => {
      const res = await request(app).post('/api/schedules').send({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        enabled: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.enabled).toBe(0);
    });
  });

  // ── PATCH /api/schedules/:id ────────────────────────────────────────────────

  describe('PATCH /api/schedules/:id', () => {
    it('updates cron/enabled/config and returns 200', async () => {
      const row = createSchedule({
        kind: 'prod-log-triage',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });

      const res = await request(app)
        .patch(`/api/schedules/${row.id}`)
        .send({ cron: '0 8 * * *', enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.cron).toBe('0 8 * * *');
      expect(res.body.enabled).toBe(0);
    });

    it('patches repoPath and new fields (name, timezone, model, timeoutMs, prompt)', async () => {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/old-repo',
        cron: '0 7 * * 1',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({
        repoPath: '/new-repo',
        name: 'Renamed',
        timezone: 'Europe/London',
        model: 'claude-sonnet-4-6',
        timeoutMs: 120000,
        prompt: 'new override prompt',
      });

      expect(res.status).toBe(200);
      expect(res.body.repo_path).toBe('/new-repo');
      expect(res.body.name).toBe('Renamed');
      expect(res.body.timezone).toBe('Europe/London');
      expect(res.body.model).toBe('claude-sonnet-4-6');
      expect(res.body.timeout_ms).toBe(120000);
      expect(res.body.prompt).toBe('new override prompt');
    });

    it('clears prompt when patched with null', async () => {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
        prompt: 'existing override',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ prompt: null });

      expect(res.status).toBe(200);
      expect(res.body.prompt).toBeNull();
    });

    it('clears name when patched with null', async () => {
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
        name: 'Named',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ name: null });

      expect(res.status).toBe(200);
      expect(res.body.name).toBeNull();
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app)
        .patch('/api/schedules/does-not-exist')
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });

    it('rejects a blank cron with 400', async () => {
      const row = createSchedule({
        kind: 'prod-log-triage',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });
      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ cron: '  ' });
      expect(res.status).toBe(400);
    });

    // ── PATCH validation table ─────────────────────────────────────────────────

    it.each([
      ['bad cron expression', { cron: 'not-a-cron' }, true],
      ['bad timezone (valid cron)', { timezone: 'Invalid/Zone' }, true],
      ['bad model (spaces)', { model: 'bad name' }, true],
      ['timeoutMs too small', { timeoutMs: 5000 }, true],
      ['timeoutMs too large', { timeoutMs: 90_000_000 }, true],
      ['timeoutMs non-integer', { timeoutMs: 1234.5 }, true],
      ['valid model', { model: 'claude-opus-4-8' }, false],
      ['valid timezone', { timezone: 'America/Chicago' }, false],
      ['valid timeoutMs', { timeoutMs: 30000 }, false],
    ])(
      'PATCH validation: %s',
      async (_desc: string, bodyPatch: Record<string, unknown>, expectBad: boolean) => {
        const row = createSchedule({
          kind: 'weekly-update',
          repoPath: '/repo',
          cron: '0 7 * * 1',
        });
        const res = await request(app).patch(`/api/schedules/${row.id}`).send(bodyPatch);
        if (expectBad) {
          expect(res.status).toBe(400);
        } else {
          expect(res.status).toBe(200);
        }
      },
    );

    // ── custom kind PATCH validation ──────────────────────────────────────────

    it('rejects enabling a custom schedule without prompt (400)', async () => {
      const row = createSchedule({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        enabled: false,
        name: 'My Custom',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ enabled: true });
      expect(res.status).toBe(400);
    });

    it('rejects enabling a custom schedule without name (400)', async () => {
      const row = createSchedule({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        enabled: false,
        prompt: 'do something',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ enabled: true });
      expect(res.status).toBe(400);
    });

    it('allows enabling a custom schedule with both name and prompt (200)', async () => {
      const row = createSchedule({
        kind: 'custom',
        repoPath: '/repo',
        cron: '0 7 * * *',
        enabled: false,
        name: 'My Custom',
        prompt: 'do something useful',
      });

      const res = await request(app).patch(`/api/schedules/${row.id}`).send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(1);
    });

    it('validates cron+timezone pair with effective values (PATCH timezone changes effective tz)', async () => {
      // Create with a valid cron (daily), then try to set invalid timezone
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
      });

      const res = await request(app)
        .patch(`/api/schedules/${row.id}`)
        .send({ timezone: 'Not/A/Timezone' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/timezone/i);
    });
  });

  // ── DELETE /api/schedules/:id ────────────────────────────────────────────────

  describe('DELETE /api/schedules/:id', () => {
    it('deletes a schedule and returns 204', async () => {
      const row = createSchedule({
        kind: 'prod-log-triage',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });

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

  // ── GET /api/schedules/:id/runs ─────────────────────────────────────────────

  describe('GET /api/schedules/:id/runs', () => {
    it('returns runs stamped with this schedule id from the runs table', async () => {
      const row = createSchedule({
        kind: 'prod-log-triage',
        repoPath: '/repo',
        cron: '0 7 * * *',
      });
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

  // ── POST /api/schedules/:id/run ──────────────────────────────────────────────

  describe('POST /api/schedules/:id/run', () => {
    it('triggers a manual run via executeScheduleRun', async () => {
      const row = createSchedule({
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

  // ── GET /api/schedules/:id/effective-prompt ──────────────────────────────────

  describe('GET /api/schedules/:id/effective-prompt', () => {
    it('returns 404 for an unknown schedule id', async () => {
      const res = await request(app).get('/api/schedules/does-not-exist/effective-prompt');
      expect(res.status).toBe(404);
    });

    it('returns kind_skill source when no schedule prompt override exists', async () => {
      // Pre-seed the schedule_skills DB so resolveScheduleSkillContent doesn't hit the filesystem
      upsertScheduleSkill('weekly-update', 'The weekly update skill content');
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
      });

      const res = await request(app).get(`/api/schedules/${row.id}/effective-prompt`);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('kind_skill');
      expect(res.body.content).toBe('The weekly update skill content');
    });

    it('returns override source after PATCHing a prompt override', async () => {
      upsertScheduleSkill('weekly-update', 'The weekly update skill content');
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
      });

      // PATCH the prompt override
      await request(app)
        .patch(`/api/schedules/${row.id}`)
        .send({ prompt: 'my custom override prompt' });

      const res = await request(app).get(`/api/schedules/${row.id}/effective-prompt`);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('override');
      expect(res.body.content).toBe('my custom override prompt');
    });

    it('falls back to kind_skill source after clearing prompt override (prompt: null)', async () => {
      upsertScheduleSkill('weekly-update', 'The weekly update skill content');
      const row = createSchedule({
        kind: 'weekly-update',
        repoPath: '/repo',
        cron: '0 7 * * 1',
        prompt: 'my custom override',
      });

      // Clear the override
      await request(app).patch(`/api/schedules/${row.id}`).send({ prompt: null });

      const res = await request(app).get(`/api/schedules/${row.id}/effective-prompt`);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('kind_skill');
      expect(res.body.content).toBe('The weekly update skill content');
    });
  });
});
