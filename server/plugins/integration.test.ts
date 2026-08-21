/**
 * Full plugin-lifecycle integration test (SHR-253/254/255/256).
 *
 * Every other test in this directory drives one registry at a time, or
 * (`lifecycle.test.ts`) builds a `PluginContext` by hand instead of going
 * through the real loader. Nothing exercises `loadPlugins()` -> serve over
 * real HTTP -> `unloadPlugin()` -> 404 in one test, which is the actual
 * property the plugin runtime exists to deliver. This file drives a real
 * fixture plugin module (written to a tmp dir, `import()`ed for real —
 * `loadPlugins`'s `resolve` seam only skips the anchor.js/createRequire
 * bare-package lookup; an absolute-path row bypasses that seam entirely and
 * still needs a real file for `import()` to load) through mount -> HTTP ->
 * unmount, and a second fixture pair through the cross-plugin `ctx.facts`
 * watch path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const { loadPlugins, unloadPlugin, reloadPlugin, resetMountedPlugins } =
  await import('./loader.js');
const { resetPluginRoutes } = await import('./http-registry.js');
const { resetFacts, putFact } = await import('./facts.js');
const { resetPluginUi } = await import('./ui-registry.js');
const { subscribeServerEvents } = await import('../events.js');
const { createTestDb, insertTestTask } = await import('../test-helpers.js');
const { createApp } = await import('../app.js');

let tmpDir: string;

function writeManifest(yaml: string): string {
  const file = path.join(tmpDir, 'octomux.yml');
  fs.writeFileSync(file, yaml, 'utf-8');
  return file;
}

function writeModule(name: string, source: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, source, 'utf-8');
  return file;
}

/** Fixture plugin that exercises all four SHR-253..256 registrars in one
 *  apply(): a route, a fact type + a write, a ui panel, and an effect that
 *  records (to a marker file, since the effect only runs post-unmount, after
 *  every registry has already been torn down) that it ran. */
function fixtureCoverageSource(taskId: string, effectMarkerPath: string): string {
  return `
import fs from 'fs';

export async function apply(ctx) {
  ctx.http.route('GET', '/thing/:id', (req, res) => {
    res.status(200).json({ id: req.params.id });
  });

  ctx.facts.define({
    type: 'coverage',
    schema: {
      type: 'object',
      properties: { pct: { type: 'number' } },
      required: ['pct'],
    },
  });
  await ctx.facts.put(${JSON.stringify(taskId)}, 'coverage', { pct: 92 });

  ctx.ui.panel({ slot: 'task.panel', fact: 'coverage', as: 'stat', title: 'Coverage' });

  ctx.effect(() => {
    fs.writeFileSync(${JSON.stringify(effectMarkerPath)}, 'ran');
  });
}
`;
}

/** Fixture "A": defines+writes `coverage` facts on demand via an HTTP route,
 *  so a test can trigger a write after A has been reloaded. */
function fixtureWriterSource(taskId: string): string {
  return `
export async function apply(ctx) {
  ctx.facts.define({
    type: 'coverage',
    schema: {
      type: 'object',
      properties: { pct: { type: 'number' } },
      required: ['pct'],
    },
  });
  ctx.http.route('POST', '/emit/:pct', async (req, res) => {
    await ctx.facts.put(${JSON.stringify(taskId)}, 'coverage', { pct: Number(req.params.pct) });
    res.status(200).json({ ok: true });
  });
}
`;
}

/** Fixture "B": watches A's QUALIFIED fact type and appends every fact it
 *  sees to a log file, so the test can inspect delivery across A's reload
 *  and confirm the subscription only dies when B itself unmounts. */
function fixtureWatcherSource(qualifiedType: string, watchLogPath: string): string {
  return `
import fs from 'fs';

export async function apply(ctx) {
  ctx.facts.watch(${JSON.stringify(qualifiedType)}, (fact) => {
    fs.appendFileSync(${JSON.stringify(watchLogPath)}, JSON.stringify(fact) + '\\n');
  });
}
`;
}

function readWatchLog(watchLogPath: string): Array<{ payload: { pct: number } }> {
  if (!fs.existsSync(watchLogPath)) return [];
  return fs
    .readFileSync(watchLogPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugin-integration-'));
  resetMountedPlugins();
  resetPluginRoutes();
  resetFacts();
  resetPluginUi();
  createTestDb();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetMountedPlugins();
  resetPluginRoutes();
  resetFacts();
  resetPluginUi();
});

describe('plugin runtime integration: mount -> HTTP -> unmount', () => {
  it('serves a fixture plugin over real HTTP, then releases everything on unloadPlugin except already-written facts', async () => {
    const task = insertTestTask();
    const effectMarker = path.join(tmpDir, 'effect-ran.txt');
    const fixturePath = writeModule(
      'fixture-coverage.mjs',
      fixtureCoverageSource(task.id, effectMarker),
    );
    const manifestPath = writeManifest(`
plugins:
  - id: fixture-a
    name: ${fixturePath}
`);

    // 1. Mount via the real loadPlugins().
    const report = await loadPlugins({ manifestPath, resolveFrom: tmpDir });
    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);

    const app = createApp();

    // 2. Serve — all three surfaces reachable over real HTTP.
    const routeRes = await request(app).get('/api/p/fixture-a/thing/42');
    expect(routeRes.status).toBe(200);
    expect(routeRes.body).toEqual({ id: '42' });

    const contribRes = await request(app).get('/api/plugin-ui/contributions');
    expect(contribRes.status).toBe(200);
    expect(contribRes.body.contributions).toHaveLength(1);
    expect(contribRes.body.contributions[0]).toMatchObject({
      pluginId: 'fixture-a',
      slot: 'task.panel',
      // Fact type must be QUALIFIED as `<pluginId>:coverage`, not bare.
      factType: 'fixture-a:coverage',
      as: 'stat',
    });

    const factsRes = await request(app).get(`/api/tasks/${task.id}/facts`);
    expect(factsRes.status).toBe(200);
    expect(factsRes.body.facts).toHaveLength(1);
    expect(factsRes.body.facts[0]).toMatchObject({
      type: 'fixture-a:coverage',
      payload: { pct: 92 },
    });

    // 3. Unmount via the real unloadPlugin() — not by hand-calling
    //    unregister* directly.
    const uiUpdatedEvents: unknown[] = [];
    const unsubscribe = subscribeServerEvents((evt) => {
      if (evt.type === 'plugin:ui-updated') uiUpdatedEvents.push(evt);
    });
    const unloadResult = await unloadPlugin('fixture-a');
    unsubscribe();
    expect(unloadResult.ok).toBe(true);

    // 4. Assert release.
    const routeAfter = await request(app).get('/api/p/fixture-a/thing/42');
    expect(routeAfter.status).toBe(404);

    const contribAfter = await request(app).get('/api/plugin-ui/contributions');
    expect(contribAfter.body.contributions).toEqual([]);

    // The fact TYPE is gone: a further put is rejected...
    await expect(putFact('fixture-a', task.id, 'coverage', { pct: 1 })).rejects.toThrow(
      /not defined/,
    );
    // ...but the already-written fact survives — it dies with the task, not
    // the plugin.
    const factsAfter = await request(app).get(`/api/tasks/${task.id}/facts`);
    expect(factsAfter.body.facts).toHaveLength(1);
    expect(factsAfter.body.facts[0]).toMatchObject({ type: 'fixture-a:coverage' });

    // ctx.effect() ran.
    expect(fs.existsSync(effectMarker)).toBe(true);
    expect(fs.readFileSync(effectMarker, 'utf-8')).toBe('ran');

    // A plugin:ui-updated event was broadcast for the unmount.
    expect(uiUpdatedEvents).toContainEqual(
      expect.objectContaining({
        type: 'plugin:ui-updated',
        payload: { pluginId: 'fixture-a' },
      }),
    );
  });
});

describe('plugin runtime integration: cross-plugin ctx.facts.watch (SHR-255)', () => {
  it("delivers A's writes to B's watcher, survives A's reload, and only dies when B unmounts", async () => {
    const task = insertTestTask();
    const watchLog = path.join(tmpDir, 'watch-log.txt');

    const writerPath = writeModule('fixture-writer.mjs', fixtureWriterSource(task.id));
    const watcherPath = writeModule(
      'fixture-watcher.mjs',
      fixtureWatcherSource('fixture-a:coverage', watchLog),
    );
    const manifestPath = writeManifest(`
plugins:
  - id: fixture-a
    name: ${writerPath}
  - id: fixture-b
    name: ${watcherPath}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: tmpDir });
    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(2);

    const app = createApp();

    // A writes -> B's callback fires.
    const emit1 = await request(app).post('/api/p/fixture-a/emit/50');
    expect(emit1.status).toBe(200);
    const afterFirstWrite = readWatchLog(watchLog);
    expect(afterFirstWrite).toHaveLength(1);
    expect(afterFirstWrite[0]).toMatchObject({ payload: { pct: 50 } });

    // Reload A. B never unmounted, so its watcher must survive.
    const reloadResult = await reloadPlugin({
      manifestPath,
      resolveFrom: tmpDir,
      id: 'fixture-a',
    });
    expect(reloadResult.ok).toBe(true);

    const emit2 = await request(app).post('/api/p/fixture-a/emit/75');
    expect(emit2.status).toBe(200);
    const afterReload = readWatchLog(watchLog);
    expect(afterReload).toHaveLength(2);
    expect(afterReload[1]).toMatchObject({ payload: { pct: 75 } });

    // Unmount B — its watcher must be released now, and only now.
    const unloadB = await unloadPlugin('fixture-b');
    expect(unloadB.ok).toBe(true);

    const emit3 = await request(app).post('/api/p/fixture-a/emit/99');
    expect(emit3.status).toBe(200);
    expect(readWatchLog(watchLog)).toHaveLength(2); // unchanged — B is gone.
  });
});
