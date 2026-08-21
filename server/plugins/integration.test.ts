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
const { insertRun } = await import('../repositories/runs.js');
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

/** Body the reporter fixture writes. Shared so the test can assert byte-exact
 *  content and the derived `size` without restating it. */
const REPORT_BODY = '# Coverage\n\n92%\n';

/** Fixture that produces OUTPUT rather than registering anything: it writes an
 *  artifact for a task on demand (`POST /report`), writes one under a
 *  caller-chosen name (`POST /report-as?task=&name=`) so the test can probe
 *  name validation through the real plugin surface, and reads them back
 *  (`GET /list`). Both write routes report the rejection as JSON instead of
 *  throwing, so the test asserts the plugin-visible error rather than
 *  whatever express's error middleware renders. */
function fixtureReporterSource(taskId: string): string {
  return `
export async function apply(ctx) {
  ctx.http.route('POST', '/report', async (req, res) => {
    try {
      const entry = await ctx.artifacts.write(${JSON.stringify(taskId)}, {
        name: 'coverage.md',
        mime: 'text/markdown',
        body: ${JSON.stringify(REPORT_BODY)},
      });
      res.status(200).json({ ok: true, entry });
    } catch (err) {
      res.status(200).json({ ok: false, error: String(err && err.message) });
    }
  });

  ctx.http.route('POST', '/report-as', async (req, res) => {
    try {
      const entry = await ctx.artifacts.write(String(req.query.task), {
        name: String(req.query.name ?? ''),
        mime: 'text/markdown',
        body: 'x',
      });
      res.status(200).json({ ok: true, entry });
    } catch (err) {
      res.status(200).json({ ok: false, error: String(err && err.message) });
    }
  });

  ctx.http.route('GET', '/list', async (req, res) => {
    res.status(200).json({ artifacts: await ctx.artifacts.list(${JSON.stringify(taskId)}) });
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

describe('plugin runtime integration: ctx.artifacts (SHR-269)', () => {
  it('writes a file during a run that surfaces on the run detail and outlives the plugin', async () => {
    // A real worktree dir, because artifacts are FILES under
    // `<worktree>/.octomux/artifacts/` — not DB rows.
    const worktree = fs.mkdtempSync(path.join(tmpDir, 'worktree-'));
    const task = insertTestTask({ worktree });
    const run = insertRun({ workflowKind: 'loop', trigger: 'manual', taskId: task.id });

    const fixturePath = writeModule('fixture-reporter.mjs', fixtureReporterSource(task.id));
    const manifestPath = writeManifest(`
plugins:
  - id: reporter
    name: ${fixturePath}
`);
    const report = await loadPlugins({ manifestPath, resolveFrom: tmpDir });
    expect(report.failed).toEqual([]);

    const app = createApp();

    // 1. The plugin produces output mid-run, through ctx.artifacts.write().
    const emit = await request(app).post('/api/p/reporter/report');
    expect(emit.status).toBe(200);
    expect(emit.body.entry).toMatchObject({
      pluginId: 'reporter',
      name: 'coverage.md',
      mime: 'text/markdown',
      url: `/api/tasks/${task.id}/artifacts/reporter/coverage.md`,
    });

    // 2. It's on disk in the worktree, where it diffs and survives a DB wipe.
    expect(
      fs.readFileSync(path.join(worktree, '.octomux/artifacts/reporter/coverage.md'), 'utf-8'),
    ).toBe(REPORT_BODY);

    // 3. It shows up in the RUN DETAIL payload — the point of the ticket. No
    //    core change was needed for THIS plugin: `services/run-detail.ts` reads
    //    whatever any plugin wrote.
    const runRes = await request(app).get(`/api/runs/${run.id}`);
    expect(runRes.status).toBe(200);
    expect(runRes.body.artifacts).toHaveLength(1);
    expect(runRes.body.artifacts[0]).toMatchObject({
      pluginId: 'reporter',
      name: 'coverage.md',
      mime: 'text/markdown',
      size: Buffer.byteLength(REPORT_BODY, 'utf8'),
    });

    // 4. And the body is fetchable over HTTP at the advertised url.
    const bodyRes = await request(app).get(runRes.body.artifacts[0].url);
    expect(bodyRes.status).toBe(200);
    expect(bodyRes.text).toBe(REPORT_BODY);

    // 5. ctx.artifacts.list() reads it back.
    const listRes = await request(app).get('/api/p/reporter/list');
    expect(listRes.body.artifacts).toHaveLength(1);

    // 6. Unmounting the plugin does NOT delete its output. An artifact is a
    //    file in the worktree; it dies with the task, not with the plugin —
    //    the same rule as an already-written fact.
    expect((await unloadPlugin('reporter')).ok).toBe(true);
    const afterUnload = await request(app).get(`/api/runs/${run.id}`);
    expect(afterUnload.body.artifacts).toHaveLength(1);
    expect((await request(app).get(`/api/tasks/${task.id}/artifacts`)).body.artifacts).toHaveLength(
      1,
    );
  });

  it('rejects a write to a task with no worktree, and cannot escape its own namespace', async () => {
    const worktree = fs.mkdtempSync(path.join(tmpDir, 'worktree-'));
    const noWorktree = insertTestTask({ id: 'task-no-wt', worktree: null });
    const withWorktree = insertTestTask({ id: 'task-with-wt', worktree });

    const manifestPath = writeManifest(`
plugins:
  - id: reporter
    name: ${writeModule('fixture-reporter.mjs', fixtureReporterSource(noWorktree.id))}
`);
    expect((await loadPlugins({ manifestPath, resolveFrom: tmpDir })).failed).toEqual([]);
    const app = createApp();

    // No worktree -> the write REJECTS. Not a silent no-op: a plugin awaiting
    // write() has to learn its output went nowhere.
    const emit = await request(app).post('/api/p/reporter/report');
    expect(emit.status).toBe(200);
    expect(emit.body).toMatchObject({ ok: false });
    expect(emit.body.error).toMatch(/no worktree/);

    // A traversing name never reaches the filesystem, and nothing lands
    // outside `<worktree>/.octomux/artifacts/`.
    for (const name of ['../escaped.md', 'nested/deep.md', '.hidden.md', '']) {
      const bad = await request(app)
        .post(`/api/p/reporter/report-as`)
        .query({ task: withWorktree.id, name });
      expect(bad.body).toMatchObject({ ok: false });
      expect(bad.body.error).toMatch(/invalid artifact name/);
    }
    expect(fs.existsSync(path.join(worktree, '..', 'escaped.md'))).toBe(false);
    // Not one of them created the plugin's artifact dir, let alone a file.
    expect(fs.existsSync(path.join(worktree, '.octomux', 'artifacts', 'reporter'))).toBe(false);
  });
});
