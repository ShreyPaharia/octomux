/**
 * `GET /api/fanout/runs(/:id)` — the read-only HTTP surface for fan-out runs.
 * Exercises the full `createApp()` stack (DB + error middleware), same style
 * as `server/routes/task-artifacts.test.ts`.
 */
import { describe, it, expect, beforeEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const { createTestDb } = await import('../test-helpers.js');
const { createApp } = await import('../app.js');
const { createFanOutRun, upsertFanOutItems, setFanOutItemStatus } =
  await import('../repositories/fanout.js');

describe('fanout routes', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('lists runs newest-first and filters by plugin and name', async () => {
    const a = createFanOutRun('plugin-a', 'plugin-a:step-1');
    db.prepare(`UPDATE fanout_runs SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(a.id);
    const b = createFanOutRun('plugin-a', 'plugin-a:step-2');
    db.prepare(`UPDATE fanout_runs SET created_at = '2020-01-02T00:00:00Z' WHERE id = ?`).run(b.id);
    const c = createFanOutRun('plugin-b', 'plugin-b:step-1');
    db.prepare(`UPDATE fanout_runs SET created_at = '2020-01-03T00:00:00Z' WHERE id = ?`).run(c.id);

    const app = createApp();

    const all = await request(app).get('/api/fanout/runs').expect(200);
    expect(all.body.runs.map((r: { runId: string }) => r.runId)).toEqual([c.id, b.id, a.id]);

    const byPlugin = await request(app).get('/api/fanout/runs?plugin=plugin-a').expect(200);
    expect(byPlugin.body.runs.map((r: { runId: string }) => r.runId)).toEqual([b.id, a.id]);

    const byName = await request(app).get('/api/fanout/runs?name=plugin-a:step-1').expect(200);
    expect(byName.body.runs.map((r: { runId: string }) => r.runId)).toEqual([a.id]);
  });

  it('honours and clamps limit, and falls back to the default on an unparseable value', async () => {
    for (let i = 0; i < 5; i++) {
      createFanOutRun('plugin-a', `plugin-a:step-${i}`);
    }
    const app = createApp();

    const limited = await request(app).get('/api/fanout/runs?limit=2').expect(200);
    expect(limited.body.runs).toHaveLength(2);

    const clamped = await request(app).get('/api/fanout/runs?limit=99999').expect(200);
    expect(clamped.body.runs).toHaveLength(5);

    const garbage = await request(app).get('/api/fanout/runs?limit=notanumber').expect(200);
    expect(garbage.body.runs).toHaveLength(5);
  });

  it('404s on an unknown run id', async () => {
    const app = createApp();
    await request(app).get('/api/fanout/runs/does-not-exist').expect(404);
  });

  it('returns items with status/attempts/result/error and correct summary counts for a mixed run', async () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:step-1');
    upsertFanOutItems(run.id, [
      { key: 'one', item: { n: 1 } },
      { key: 'two', item: { n: 2 } },
      { key: 'three', item: { n: 3 } },
    ]);
    setFanOutItemStatus(run.id, 'one', { status: 'done', attempts: 1, result: { ok: true } });
    setFanOutItemStatus(run.id, 'two', { status: 'dead', attempts: 3, error: 'boom' });
    // 'three' stays pending

    const app = createApp();
    const res = await request(app).get(`/api/fanout/runs/${run.id}`).expect(200);

    expect(res.body.runId).toBe(run.id);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.dead).toBe(1);
    expect(res.body.pending).toBe(1);

    interface ItemJson {
      key: string;
      status: string;
      attempts: number;
      result?: unknown;
      error?: string;
    }
    const byKey: Record<string, ItemJson> = Object.fromEntries(
      (res.body.items as ItemJson[]).map((i) => [i.key, i]),
    );
    expect(byKey.one.status).toBe('done');
    expect(byKey.one.attempts).toBe(1);
    expect(byKey.one.result).toEqual({ ok: true });
    expect(byKey.two.status).toBe('dead');
    expect(byKey.two.error).toBe('boom');
    expect(byKey.three.status).toBe('pending');
  });

  it('reports all-zero counts and an empty items array for a run with zero items', async () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:step-empty');
    const app = createApp();
    const res = await request(app).get(`/api/fanout/runs/${run.id}`).expect(200);

    expect(res.body.total).toBe(0);
    expect(res.body.succeeded).toBe(0);
    expect(res.body.dead).toBe(0);
    expect(res.body.pending).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});
