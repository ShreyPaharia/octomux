import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { insertRun, finishRun } from './repositories/runs.js';
import './workflows/index.js';

describe('GET /api/workflows/:kind/runs', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
  });

  it('returns runs for the given workflow kind', async () => {
    const run = insertRun({ workflowKind: 'pr-extract', trigger: 'github' });
    insertRun({ workflowKind: 'reviewer', trigger: 'github' });

    const res = await request(app).get('/api/workflows/pr-extract/runs');

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].id).toBe(run.id);
  });

  it('returns an empty list for a kind with no runs', async () => {
    const res = await request(app).get('/api/workflows/unknown-kind/runs');

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it('includes result_json for a finished session run (no task_id)', async () => {
    const run = insertRun({ workflowKind: 'overnight-log-summary', trigger: 'cron' });
    finishRun(run.id, { status: 'done', result: { window: 'last 12h', summary: 'all clear' } });

    const res = await request(app).get('/api/workflows/overnight-log-summary/runs');

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
        'loops',
        'overnight-log-summary',
        'pr-extract',
        'prod-log-triage',
        'reviewer',
        'weekly-update',
      ]),
    );

    const prExtract = res.body.workflows.find((w: { kind: string }) => w.kind === 'pr-extract');
    expect(prExtract).toMatchObject({
      displayName: 'PR Extracts',
      surfaces: ['feed', 'artifact'],
      trigger: { kind: 'github', event: 'pr_merged' },
      runCount: 2,
    });
    expect(prExtract.output).toBeDefined();

    const loops = res.body.workflows.find((w: { kind: string }) => w.kind === 'loops');
    expect(loops.runCount).toBe(0);
    expect(loops.trigger).toEqual({ kind: 'manual' });
    expect(loops.output).toBeNull();

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
