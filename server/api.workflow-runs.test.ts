import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { insertRun, finishRun } from './repositories/runs.js';
import './workflows/index.js';

describe('GET /api/runs?kind=', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  it('returns runs for the given workflow kind', async () => {
    const run = insertRun({ workflowKind: 'pr-extract', trigger: 'github' });
    insertRun({ workflowKind: 'reviewer', trigger: 'github' });

    const res = await request(app).get('/api/runs?kind=pr-extract');

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].id).toBe(run.id);
  });

  it('returns an empty list for a kind with no runs', async () => {
    const res = await request(app).get('/api/runs?kind=unknown-kind');

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it('includes result_json for a finished session run (no task_id)', async () => {
    const run = insertRun({ workflowKind: 'overnight-log-summary', trigger: 'cron' });
    finishRun(run.id, { status: 'done', result: { window: 'last 12h', summary: 'all clear' } });

    const res = await request(app).get('/api/runs?kind=overnight-log-summary');

    expect(res.status).toBe(200);
    expect(res.body.runs[0].task_id).toBeNull();
    expect(JSON.parse(res.body.runs[0].result_json)).toEqual({
      window: 'last 12h',
      summary: 'all clear',
    });
  });
});

describe('GET /api/workflows', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  it('lists every registered workflow with trigger + run count', async () => {
    insertRun({ workflowKind: 'pr-extract', trigger: 'github' });
    insertRun({ workflowKind: 'pr-extract', trigger: 'github' });

    const res = await request(app).get('/api/workflows');

    expect(res.status).toBe(200);
    const kinds = res.body.workflows.map((w: { kind: string }) => w.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'daily-plan',
        'doc-drift',
        'overnight-log-summary',
        'pr-extract',
        'prod-log-triage',
        'reviewer',
        'weekly-update',
      ]),
    );
    // The 'loops' workflow kind (server/workflows/loops/index.ts, deleted) existed
    // solely to mount the now-deleted routes/loops.ts as its apiRouter — see
    // server/routes/runs.ts's module doc for the loop/loop-group route collapse.
    expect(kinds).not.toContain('loops');

    const prExtract = res.body.workflows.find((w: { kind: string }) => w.kind === 'pr-extract');
    expect(prExtract).toMatchObject({
      displayName: 'PR Extracts',
      surfaces: ['feed', 'artifact'],
      trigger: { kind: 'github', event: 'pr_merged' },
      runCount: 2,
    });
    expect(prExtract.output).toBeDefined();

    const overnightLogSummary = res.body.workflows.find(
      (w: { kind: string }) => w.kind === 'overnight-log-summary',
    );
    expect(overnightLogSummary).toMatchObject({
      displayName: 'Overnight Log Summary',
      surfaces: ['artifact'],
      trigger: { kind: 'cron' },
    });
    expect(overnightLogSummary.output).toBeDefined();
  });
});

describe('GET /api/runs', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  it('returns runs across all kinds', async () => {
    insertRun({ workflowKind: 'doc-drift', trigger: 'cron' });
    insertRun({ workflowKind: 'reviewer', trigger: 'github' });

    const res = await request(app).get('/api/runs');

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0]).toHaveProperty('workflow_kind');
    expect(res.body.runs[0]).toHaveProperty('effective_status');
  });
});
