/**
 * `GET /api/plugin-ui/contributions`, `GET /api/surfaces`,
 * `GET /api/tasks/:id/panels`, and (SHR-257) `GET /api/plugin-ui/actions` +
 * `POST /api/plugin-ui/actions/:actionId` — the HTTP surface for
 * `ctx.surfaces` and the `ctx.ui` contribution/action tables. Exercises the
 * full `createApp()` stack (DB + error middleware), same shape as
 * `task-artifacts.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const { createTestDb, insertTask } = await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { registerPluginUiPanel, resetPluginUi, registerPluginUiAction } =
  await import('../plugins/ui-registry.js');
const { defineStore, putRecord, resetRecords } = await import('../plugins/records.js');
const { registerSurface, unregisterSurface } = await import('../surfaces/index.js');
const { renderPanelText } = await import('../surfaces/text.js');

const PLUGIN_ID = 'demo-plugin';

describe('plugin-ui routes', () => {
  beforeEach(() => {
    createTestDb();
    resetPluginUi();
    resetRecords();
  });

  afterEach(() => {
    resetPluginUi();
    resetRecords();
    unregisterSurface('test-narrow');
  });

  function seedPanel(overrides: Partial<{ slot: string; record: string; as: string }> = {}) {
    defineStore(PLUGIN_ID, { name: overrides.record ?? 'metric', scope: 'task', mode: 'append' });
    registerPluginUiPanel(PLUGIN_ID, {
      slot: (overrides.slot ?? 'task.panel') as never,
      record: overrides.record ?? 'metric',
      as: overrides.as ?? 'stat',
    });
  }

  it('contributions with no ?surface= is byte-identical to the raw table (no behaviour change)', async () => {
    seedPanel();
    const { listUiContributions } = await import('../plugins/ui-registry.js');
    const raw = listUiContributions();

    const app = createApp();
    const res = await request(app).get('/api/plugin-ui/contributions').expect(200);

    expect(res.body).toEqual({ contributions: raw });
    expect(res.body.contributions[0].renderer).toBeUndefined();
  });

  it('contributions with ?surface=cli adds a renderer field', async () => {
    seedPanel({ as: 'stat' });

    const app = createApp();
    const res = await request(app).get('/api/plugin-ui/contributions?surface=cli').expect(200);

    expect(res.body.contributions).toHaveLength(1);
    expect(res.body.contributions[0].renderer).toBe('stat');
    expect(res.body.contributions[0].pluginId).toBe(PLUGIN_ID);
  });

  it('contributions with ?surface=nope 404s', async () => {
    const app = createApp();
    const res = await request(app).get('/api/plugin-ui/contributions?surface=nope').expect(404);
    expect(res.body).toEqual({ error: 'unknown surface "nope"' });
  });

  it('GET /api/surfaces lists the four core kinds plus a registered plugin surface', async () => {
    registerSurface({
      kind: 'test-narrow',
      renderers: ['badge'],
      fallback: 'json',
      render: renderPanelText,
    });

    const app = createApp();
    const res = await request(app).get('/api/surfaces').expect(200);

    const byKind = Object.fromEntries(
      (
        res.body.surfaces as Array<{
          kind: string;
          core: boolean;
          canRender: boolean;
          canPrompt: boolean;
          fallback: string;
        }>
      ).map((s) => [s.kind, s]),
    );

    for (const kind of ['web', 'cli', 'slack', 'telegram']) {
      expect(byKind[kind].core).toBe(true);
      expect(byKind[kind].canPrompt).toBe(false);
    }
    expect(byKind.web.canRender).toBe(false);
    expect(byKind.cli.canRender).toBe(true);

    expect(byKind['test-narrow'].core).toBe(false);
    expect(byKind['test-narrow'].canRender).toBe(true);
    expect(byKind['test-narrow'].fallback).toBe('json');
  });

  it('GET /api/tasks/:id/panels?surface=cli renders a seeded panel', async () => {
    const db = getDb();
    insertTask(db, { id: 'panels-task-1' });
    seedPanel({ record: 'metric', as: 'stat' });
    await putRecord(PLUGIN_ID, 'metric', { value: 42 }, 'panels-task-1');

    const app = createApp();
    const res = await request(app).get('/api/tasks/panels-task-1/panels?surface=cli').expect(200);

    expect(res.body.panels).toHaveLength(1);
    expect(res.body.panels[0].pluginId).toBe(PLUGIN_ID);
    expect(res.body.panels[0].as).toBe('stat');
    expect(res.body.panels[0].renderer).toBe('stat');
    expect(typeof res.body.panels[0].text).toBe('string');
    expect(res.body.panels[0].text.length).toBeGreaterThan(0);
  });

  it('a panel bound to a renderer the surface does not declare falls back and still renders', async () => {
    registerSurface({
      kind: 'test-narrow',
      renderers: ['badge'],
      fallback: 'json',
      render: renderPanelText,
    });
    const db = getDb();
    insertTask(db, { id: 'panels-task-2' });
    seedPanel({ record: 'metric', as: 'stat' });
    await putRecord(PLUGIN_ID, 'metric', { value: 7 }, 'panels-task-2');

    const app = createApp();
    const res = await request(app)
      .get('/api/tasks/panels-task-2/panels?surface=test-narrow')
      .expect(200);

    expect(res.body.panels).toHaveLength(1);
    expect(res.body.panels[0].as).toBe('stat');
    expect(res.body.panels[0].renderer).toBe('json');
    expect(res.body.panels[0].text.length).toBeGreaterThan(0);
  });

  it('surface=web 400s — the web client reads the contributions table instead', async () => {
    const db = getDb();
    insertTask(db, { id: 'panels-task-3' });

    const app = createApp();
    const res = await request(app).get('/api/tasks/panels-task-3/panels?surface=web').expect(400);

    expect(res.body).toEqual({
      error: 'surface "web" has no render — the client renders it',
    });
  });

  it('missing surface query param 400s', async () => {
    const db = getDb();
    insertTask(db, { id: 'panels-task-4' });

    const app = createApp();
    const res = await request(app).get('/api/tasks/panels-task-4/panels').expect(400);
    expect(res.body).toEqual({ error: 'surface query param is required' });
  });

  it('404s for an unknown task', async () => {
    const app = createApp();
    await request(app).get('/api/tasks/does-not-exist/panels?surface=cli').expect(404);
  });
});

/**
 * `GET /api/plugin-collections/:name/panels` (SHR-279, generalized to any
 * `ctx.records` store under SHR-282) — the durable-store counterpart to
 * `/api/tasks/:id/panels`. No task anywhere in these tests: that is the
 * point of the route.
 */
describe('plugin record-store panels route', () => {
  beforeEach(() => {
    createTestDb();
    resetPluginUi();
    resetRecords();
  });

  afterEach(() => {
    resetPluginUi();
    resetRecords();
    unregisterSurface('test-narrow');
  });

  async function seedStorePanel(as = 'table') {
    defineStore(PLUGIN_ID, { name: 'deals', scope: 'durable', mode: 'upsert', key: 'id' });
    registerPluginUiPanel(PLUGIN_ID, {
      slot: 'settings.card',
      record: 'deals',
      as: as as never,
      title: 'Pipeline',
    });
    await putRecord(PLUGIN_ID, 'deals', { id: 'd-1', stage: 'won' });
    await putRecord(PLUGIN_ID, 'deals', { id: 'd-2', stage: 'lost' });
  }

  it('renders a store-bound panel on cli, with no task involved', async () => {
    await seedStorePanel();

    const app = createApp();
    const res = await request(app)
      .get(`/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=cli`)
      .expect(200);

    expect(res.body.panels).toHaveLength(1);
    expect(res.body.panels[0].pluginId).toBe(PLUGIN_ID);
    expect(res.body.panels[0].slot).toBe('settings.card');
    expect(res.body.panels[0].renderer).toBe('table');
    expect(res.body.panels[0].text).toContain('d-1');
    expect(res.body.panels[0].text).toContain('d-2');
  });

  it('degrades to a surface fallback the same way the task route does', async () => {
    registerSurface({
      kind: 'test-narrow',
      renderers: ['badge'],
      fallback: 'json',
      render: renderPanelText,
    });
    await seedStorePanel();

    const app = createApp();
    const res = await request(app)
      .get(
        `/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=test-narrow`,
      )
      .expect(200);

    expect(res.body.panels[0].as).toBe('table');
    expect(res.body.panels[0].renderer).toBe('json');
  });

  it('windows the store with limit/orderBy', async () => {
    await seedStorePanel();

    const app = createApp();
    const res = await request(app)
      .get(
        `/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=cli&orderBy=id&order=desc&limit=1`,
      )
      .expect(200);

    expect(res.body.panels[0].text).toContain('d-2');
    expect(res.body.panels[0].text).not.toContain('d-1');
  });

  it('an unusable orderBy field is a 400, not a 500', async () => {
    await seedStorePanel();

    const app = createApp();
    await request(app)
      .get(
        `/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=cli&orderBy=not%20a%20field`,
      )
      .expect(400);
  });

  it('a store nothing binds to renders no panels rather than 404ing', async () => {
    await seedStorePanel();

    const app = createApp();
    const res = await request(app)
      .get(`/api/plugin-collections/${PLUGIN_ID}%3Aother/panels?surface=cli`)
      .expect(200);
    expect(res.body.panels).toEqual([]);
  });

  it('surface=web 400s — the browser draws these panels itself', async () => {
    await seedStorePanel();

    const app = createApp();
    const res = await request(app)
      .get(`/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=web`)
      .expect(400);
    expect(res.body).toEqual({
      error: 'surface "web" has no render — the client renders it',
    });
  });

  it('missing surface query param 400s; an unknown surface 404s', async () => {
    await seedStorePanel();

    const app = createApp();
    const name = encodeURIComponent(`${PLUGIN_ID}:deals`);
    await request(app).get(`/api/plugin-collections/${name}/panels`).expect(400);
    await request(app).get(`/api/plugin-collections/${name}/panels?surface=nope`).expect(404);
  });
});

/**
 * `GET /api/plugin-ui/actions` + `POST /api/plugin-ui/actions/:actionId`
 * (SHR-257). The invoke route runs `run` IN THE HOST process — these tests
 * assert only the JSON contract, never anything plugin-authored crossing
 * into the response beyond what `run` itself returned.
 */
describe('plugin-ui actions route', () => {
  beforeEach(() => {
    createTestDb();
    resetPluginUi();
  });

  afterEach(() => {
    resetPluginUi();
  });

  it('GET /api/plugin-ui/actions lists registered actions with no "run"', async () => {
    registerPluginUiAction(PLUGIN_ID, {
      id: 'rerun',
      label: 'Re-run',
      slot: 'task.panel',
      run: async () => ({ message: 'ok' }),
    });

    const app = createApp();
    const res = await request(app).get('/api/plugin-ui/actions').expect(200);

    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      actionId: `${PLUGIN_ID}:rerun`,
      id: 'rerun',
      label: 'Re-run',
      slot: 'task.panel',
    });
    expect(res.body.actions[0].run).toBeUndefined();
  });

  it('GET /api/plugin-ui/actions?slot= filters', async () => {
    registerPluginUiAction(PLUGIN_ID, {
      id: 'rerun',
      label: 'Re-run',
      slot: 'task.panel',
      run: async () => {},
    });
    registerPluginUiAction(PLUGIN_ID, {
      id: 'purge',
      label: 'Purge',
      slot: 'settings.card',
      run: async () => {},
    });

    const app = createApp();
    const res = await request(app).get('/api/plugin-ui/actions?slot=settings.card').expect(200);

    expect(res.body.actions.map((a: { id: string }) => a.id)).toEqual(['purge']);
  });

  it('POST invokes the action and returns its message', async () => {
    let seenTaskId: string | undefined;
    registerPluginUiAction(PLUGIN_ID, {
      id: 'rerun',
      label: 'Re-run',
      run: async ({ taskId }) => {
        seenTaskId = taskId;
        return { message: 'rerun triggered' };
      },
    });
    const db = getDb();
    insertTask(db, { id: 'action-task-1' });

    const app = createApp();
    const res = await request(app)
      .post(`/api/plugin-ui/actions/${encodeURIComponent(`${PLUGIN_ID}:rerun`)}`)
      .send({ taskId: 'action-task-1' })
      .expect(200);

    expect(res.body).toEqual({ ok: true, message: 'rerun triggered' });
    expect(seenTaskId).toBe('action-task-1');
  });

  it('POST 404s for an unknown action id', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/plugin-ui/actions/${encodeURIComponent(`${PLUGIN_ID}:nope`)}`)
      .send({})
      .expect(404);
    expect(res.body.error).toMatch(/unknown ui action/);
  });

  it('POST 404s when taskId names a task that does not exist', async () => {
    registerPluginUiAction(PLUGIN_ID, { id: 'rerun', label: 'Re-run', run: async () => {} });

    const app = createApp();
    await request(app)
      .post(`/api/plugin-ui/actions/${encodeURIComponent(`${PLUGIN_ID}:rerun`)}`)
      .send({ taskId: 'does-not-exist' })
      .expect(404);
  });

  it('POST 400s on a schema violation', async () => {
    registerPluginUiAction(PLUGIN_ID, {
      id: 'rerun',
      label: 'Re-run',
      schema: {
        type: 'object',
        properties: { branch: { type: 'string' } },
        required: ['branch'],
      },
      run: async () => {},
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/plugin-ui/actions/${encodeURIComponent(`${PLUGIN_ID}:rerun`)}`)
      .send({ input: {} })
      .expect(400);
    expect(res.body.error).toMatch(/invalid input for ui action/);
  });
});
