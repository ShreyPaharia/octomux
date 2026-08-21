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
