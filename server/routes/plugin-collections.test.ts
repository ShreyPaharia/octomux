/**
 * `parseCollectionQuery` (`plugin-collections.ts`) windows a `ctx.records`
 * store read — exercised here through `GET /api/plugin-records/:name`
 * (`plugin-records.ts`), the route that consumes it for an unscoped,
 * durable-store read. Ported from the old `GET /api/plugin-collections/:name`
 * route this file used to cover directly, before that route was replaced
 * under SHR-282; same behavior, new endpoint. Exercises the full
 * `createApp()` stack (DB + error middleware) because the 400-on-bad-orderBy
 * behavior lives in the error middleware, not in the router alone.
 */
import { describe, it, expect, beforeEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const { createTestDb } = await import('../test-helpers.js');
const { upsertRecord } = await import('../repositories/plugin-records.js');
const { createApp } = await import('../app.js');

describe('plugin records unscoped read route', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns records for a qualified store name', async () => {
    upsertRecord('coverage-bot:baselines', null, 'main', { branch: 'main', pct: 87 });
    upsertRecord('coverage-bot:baselines', null, 'dev', { branch: 'dev', pct: 91 });

    const app = createApp();
    const res = await request(app).get('/api/plugin-records/coverage-bot:baselines').expect(200);

    expect(res.body.records).toHaveLength(2);
    const byKey = Object.fromEntries(
      (res.body.records as Array<{ key: string; payload: unknown }>).map((r) => [r.key, r.payload]),
    );
    expect(byKey.main).toEqual({ branch: 'main', pct: 87 });
    expect(byKey.dev).toEqual({ branch: 'dev', pct: 91 });
  });

  it('resolves a URL-encoded ":" in the qualified name', async () => {
    upsertRecord('coverage-bot:baselines', null, 'main', { pct: 87 });

    const app = createApp();
    const res = await request(app).get('/api/plugin-records/coverage-bot%3Abaselines').expect(200);

    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].store).toBe('coverage-bot:baselines');
  });

  it('honours limit, offset, orderBy and order', async () => {
    upsertRecord('coverage-bot:baselines', null, 'a', { pct: 10 });
    upsertRecord('coverage-bot:baselines', null, 'b', { pct: 30 });
    upsertRecord('coverage-bot:baselines', null, 'c', { pct: 20 });

    const app = createApp();
    const res = await request(app)
      .get('/api/plugin-records/coverage-bot:baselines')
      .query({ orderBy: 'pct', order: 'desc', limit: 2, offset: 1 })
      .expect(200);

    // Full order by pct desc would be b(30), c(20), a(10); offset 1, limit 2 -> c, a.
    expect(res.body.records.map((r: { key: string }) => r.key)).toEqual(['c', 'a']);
  });

  it('ignores a garbage order value rather than 500ing', async () => {
    upsertRecord('coverage-bot:baselines', null, 'a', { pct: 10 });

    const app = createApp();
    const res = await request(app)
      .get('/api/plugin-records/coverage-bot:baselines')
      .query({ order: 'sideways' })
      .expect(200);

    expect(res.body.records).toHaveLength(1);
  });

  it('400s on a garbage orderBy field name', async () => {
    upsertRecord('coverage-bot:baselines', null, 'a', { pct: 10 });

    const app = createApp();
    const res = await request(app)
      .get('/api/plugin-records/coverage-bot:baselines')
      .query({ orderBy: '123-not-a-valid-field' })
      .expect(400);

    expect(res.body.error).toMatch(/invalid field name/);
  });

  it('returns an empty list for an unknown store, not a 404', async () => {
    const app = createApp();
    const res = await request(app).get('/api/plugin-records/nobody-defined:anything').expect(200);

    expect(res.body.records).toEqual([]);
  });
});
