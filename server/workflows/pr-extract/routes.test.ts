/**
 * Proof that pr-extract's two read-only routes also serve through the new
 * `ctx.http.route()` mechanism (`registerPluginRoute` + `createPluginParentRouter`,
 * mounted at `/api/p`), alongside the legacy literal paths already covered by
 * `server/api.pr-extracts.test.ts`. See the doc comment above the handlers in
 * `./routes.ts` for why `POST .../emit` does not get a twin here.
 */
import express from 'express';
import { describe, it, expect, beforeEach } from '../../bun-test.js';
import { createTestDb, insertTask } from '../../test-helpers.js';
import { createExtract } from '../../repositories/pr-extracts.js';

const { default: request } = await import('supertest');
const { createPluginParentRouter } = await import('../../plugins/http-registry.js');
const { errorMiddleware } = await import('../../error-middleware.js');
// Side effect: registers pr-extract's routes into the shared table.
await import('./routes.js');

function makeApp() {
  const app = express();
  app.use('/api/p', createPluginParentRouter());
  app.use(errorMiddleware);
  return app;
}

describe('pr-extract — new mechanism proof', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('lists extracts at /api/p/pr-extract/pr-extracts', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/p/pr-extract/pr-extracts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('gets a single extract by id at /api/p/pr-extract/pr-extracts/:id', async () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1', source: 'pr_extract' });
    const row = createExtract({
      taskId: 'task-1',
      repoPath: '/tmp/repo',
      prNumber: 1,
      prHeadSha: 'sha',
      area: 'server',
      risk: 'low',
      hasMigration: false,
      surface: 'api',
      loc: 5,
    });

    const app = makeApp();
    const res = await request(app).get(`/api/p/pr-extract/pr-extracts/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row.id);
  });

  it('404s an unknown extract id through the new namespace', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/p/pr-extract/pr-extracts/no-such-id');
    expect(res.status).toBe(404);
  });
});
