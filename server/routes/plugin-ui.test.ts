/**
 * `GET /api/plugin-ui/contributions`, `GET /api/surfaces`, and
 * `GET /api/tasks/:id/panels` — the HTTP surface for `ctx.surfaces` and the
 * `ctx.ui` contribution table it renders. Exercises the full `createApp()`
 * stack (DB + error middleware), same shape as `task-artifacts.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const { createTestDb, insertTask } = await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { registerPluginUiPanel, resetPluginUi } = await import('../plugins/ui-registry.js');
const { defineFactType, putFact, resetFacts } = await import('../plugins/facts.js');
const { defineCollection, putRecord, resetCollections } = await import('../plugins/collections.js');
const { registerSurface, unregisterSurface } = await import('../surfaces/index.js');
const { renderPanelText } = await import('../surfaces/text.js');

const PLUGIN_ID = 'demo-plugin';

describe('plugin-ui routes', () => {
  beforeEach(() => {
    createTestDb();
    resetPluginUi();
    resetFacts();
  });

  afterEach(() => {
    resetPluginUi();
    resetFacts();
    unregisterSurface('test-narrow');
  });

  function seedPanel(overrides: Partial<{ slot: string; fact: string; as: string }> = {}) {
    defineFactType(PLUGIN_ID, { type: overrides.fact ?? 'metric', schema: {} });
    registerPluginUiPanel(PLUGIN_ID, {
      slot: (overrides.slot ?? 'task.panel') as never,
      fact: overrides.fact ?? 'metric',
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
    seedPanel({ fact: 'metric', as: 'stat' });
    await putFact(PLUGIN_ID, 'panels-task-1', 'metric', { value: 42 });

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
    seedPanel({ fact: 'metric', as: 'stat' });
    await putFact(PLUGIN_ID, 'panels-task-2', 'metric', { value: 7 });

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
 * `GET /api/plugin-collections/:name/panels` (SHR-279) — the collection-bound
 * counterpart to `/api/tasks/:id/panels`. No task anywhere in these tests:
 * that is the point of the route.
 */
describe('plugin collection panels route', () => {
  beforeEach(() => {
    createTestDb();
    resetPluginUi();
    resetFacts();
    resetCollections();
  });

  afterEach(() => {
    resetPluginUi();
    resetFacts();
    resetCollections();
    unregisterSurface('test-narrow');
  });

  async function seedCollectionPanel(as = 'table') {
    defineCollection(PLUGIN_ID, { name: 'deals', schema: {}, key: 'id' });
    registerPluginUiPanel(PLUGIN_ID, {
      slot: 'settings.card',
      collection: 'deals',
      as: as as never,
      title: 'Pipeline',
    });
    await putRecord(PLUGIN_ID, 'deals', { id: 'd-1', stage: 'won' });
    await putRecord(PLUGIN_ID, 'deals', { id: 'd-2', stage: 'lost' });
  }

  it('renders a collection-bound panel on cli, with no task involved', async () => {
    await seedCollectionPanel();

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
    await seedCollectionPanel();

    const app = createApp();
    const res = await request(app)
      .get(
        `/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=test-narrow`,
      )
      .expect(200);

    expect(res.body.panels[0].as).toBe('table');
    expect(res.body.panels[0].renderer).toBe('json');
  });

  it('windows the collection with limit/orderBy', async () => {
    await seedCollectionPanel();

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
    await seedCollectionPanel();

    const app = createApp();
    await request(app)
      .get(
        `/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=cli&orderBy=not%20a%20field`,
      )
      .expect(400);
  });

  it('a collection nothing binds to renders no panels rather than 404ing', async () => {
    await seedCollectionPanel();

    const app = createApp();
    const res = await request(app)
      .get(`/api/plugin-collections/${PLUGIN_ID}%3Aother/panels?surface=cli`)
      .expect(200);
    expect(res.body.panels).toEqual([]);
  });

  it('surface=web 400s — the browser draws collection panels itself', async () => {
    await seedCollectionPanel();

    const app = createApp();
    const res = await request(app)
      .get(`/api/plugin-collections/${encodeURIComponent(`${PLUGIN_ID}:deals`)}/panels?surface=web`)
      .expect(400);
    expect(res.body).toEqual({
      error: 'surface "web" has no render — the client renders it',
    });
  });

  it('missing surface query param 400s; an unknown surface 404s', async () => {
    await seedCollectionPanel();

    const app = createApp();
    const name = encodeURIComponent(`${PLUGIN_ID}:deals`);
    await request(app).get(`/api/plugin-collections/${name}/panels`).expect(400);
    await request(app).get(`/api/plugin-collections/${name}/panels?surface=nope`).expect(404);
  });
});
