import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { insertRun } from './repositories/runs.js';

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
});
