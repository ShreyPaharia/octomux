import { describe, it, expect, beforeEach, afterEach, vi, mock, spyOn } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadPlugins,
  unloadPlugin,
  reloadPlugin,
  watchLocalPlugins,
  getMountedPlugin,
  resetMountedPlugins,
} from './loader.js';
import { manifestPath as defaultManifestPath } from './paths.js';
import { listHarnesses, resetHarnesses, getHarness } from '../harnesses/registry.js';
import { getWorkflow } from '../workflows/registry.js';
import { resetPluginRoutes, listPluginRoutes } from './http-registry.js';
import { resetRecords } from './records.js';
import { subscribeServerEvents } from '../events.js';
import { resetPluginGrants } from './grants.js';
import { resetServices } from './services.js';
import { createTestDb } from '../test-helpers.js';

let tmpDir: string;
let nodeModulesDir: string;

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-loader-test-'));
  nodeModulesDir = path.join(tmpDir, 'node_modules');
  // ctx.records now reads/writes real SQLite (plugin_records) rather than
  // throwing a stub — give it an in-memory DB so the "hands apply() a real
  // context" test below can exercise it without touching the real data dir.
  createTestDb();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetPluginGrants();
  resetServices();
});

describe('loadPlugins', () => {
  it('loads an absolute-path row directly', async () => {
    const abs = writeModule('abs-plugin.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: absplug
    name: ${abs}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.safeMode).toBe(false);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0]).toMatchObject({
      id: 'absplug',
      name: abs,
      version: 'unknown',
      resolvedPath: abs,
      order: 0,
    });
    expect(typeof report.loaded[0].applyMs).toBe('number');
  });

  it('resolves a bare package name via the anchor (real S1 resolution, no resolve override)', async () => {
    const pkgDir = path.join(nodeModulesDir, 'demo-plugin');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.mjs' }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.mjs'), 'export async function apply() {}\n');

    const manifestPath = writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0].id).toBe('demo');
    expect(report.loaded[0].resolvedPath).toContain(path.join('demo-plugin', 'index.mjs'));
  });

  it('a module that throws in apply() lands in failed with phase apply, and does not stop the next row', async () => {
    const boom = writeModule(
      'boom.mjs',
      'export async function apply() { throw new Error("kaboom"); }\n',
    );
    const ok = writeModule('ok.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: boom
    name: ${boom}
  - id: ok
    name: ${ok}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'boom', name: boom, phase: 'apply' });
    expect(report.failed[0].error).toContain('kaboom');

    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0]).toMatchObject({ id: 'ok', name: ok });
  });

  it('a row that fails to resolve gets phase resolve, and never gets imported', async () => {
    const manifestPath = writeManifest(`
plugins:
  - id: ghost
    name: ghost-pkg
`);

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      resolve: async (name) => {
        throw new Error(`cannot resolve ${name}`);
      },
    });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'ghost', name: 'ghost-pkg', phase: 'resolve' });
    expect(report.failed[0].error).toContain('cannot resolve ghost-pkg');
  });

  it('a hanging apply() hits the injected timeout', async () => {
    const hang = writeModule(
      'hang.mjs',
      'export function apply() { return new Promise(() => {}); }\n',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: hangs
    name: ${hang}
`);

    // A real timer, not fake ones: loadPlugins awaits a dynamic import() before
    // it reaches the setTimeout, so under fake timers `advanceTimersByTimeAsync`
    // returns before the timer is ever scheduled and the loader then waits
    // forever on a timer that never fires.
    //
    // The budget has to clear real import latency, because the same
    // `applyTimeoutMs` also bounds the import() above apply(). At 10ms a loaded
    // machine loses the race on the import instead, and this fails with
    // phase 'import' — flakily, only under the parallel suite.
    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      applyTimeoutMs: 250,
    });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'hangs', phase: 'apply' });
    expect(report.failed[0].error).toContain('timed out');
  });

  it('disabled: true rows are skipped, never resolved or imported, and reported as neither loaded nor failed', async () => {
    const manifestPath = writeManifest(`
plugins:
  - id: off
    name: never-touched-pkg
    disabled: true
`);
    const resolveSpy = mock(async () => {
      throw new Error('resolve should never be called for a disabled row');
    });

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      resolve: resolveSpy,
    });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('NODE_ENV=test with the unconfigured default manifestPath does zero filesystem work, even when a real manifest file exists on disk', async () => {
    // A weaker version of this test only stubs nothing and asserts readSpy was
    // never called — but readManifest() does existsSync() first, so on a
    // machine with no real ~/.octomux/octomux.yml, readFileSync was *never*
    // going to be called either way. That version can't tell "the guard
    // worked" from "there was nothing to read". Point OCTOMUX_DATA_DIR at a
    // tmpdir holding a real, valid manifest so the guard has something to
    // actually skip.
    vi.stubEnv('OCTOMUX_DATA_DIR', tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'octomux.yml'),
      'plugins:\n  - id: poison\n    name: poison-pkg\n',
      'utf-8',
    );
    const readSpy = spyOn(fs, 'readFileSync');

    const report = await loadPlugins({
      manifestPath: defaultManifestPath(),
      resolveFrom: nodeModulesDir,
      resolve: mock(async () => {
        throw new Error('resolve should never be called');
      }),
    });

    expect(report).toEqual({
      loaded: [],
      failed: [],
      manifestPath: defaultManifestPath(),
      safeMode: false,
      loadedAt: expect.any(String),
    });
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('OCTOMUX_SAFE_MODE skips every plugin row without reading the manifest', async () => {
    vi.stubEnv('OCTOMUX_SAFE_MODE', '1');
    const readSpy = spyOn(fs, 'readFileSync');

    const manifestPath = writeManifest(`
plugins:
  - id: whatever
    name: whatever-pkg
`);
    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report).toEqual({
      loaded: [],
      failed: [],
      manifestPath,
      safeMode: true,
      loadedAt: expect.any(String),
    });
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('a resolved bare-name path that escapes the plugin prefix is rejected (phase resolve), never imported', async () => {
    // createRequire walks up the directory tree, so a bare package name not
    // actually installed under resolveFrom (pluginModulesDir()) can still
    // resolve from an ancestor node_modules — an unmanaged location. Simulate
    // that "escaped" resolution directly via the resolve seam.
    const outside = writeModule('escaped.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: escaped
    name: some-bare-pkg
`);

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      resolve: async () => outside,
    });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      id: 'escaped',
      name: 'some-bare-pkg',
      phase: 'resolve',
    });
    expect(report.failed[0].error).toContain('escapes the plugin prefix');
  });

  it('an absolute-path row is never subject to the plugin-prefix check, even though it sits outside resolveFrom', async () => {
    const abs = writeModule('outside-abs.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: absok
    name: ${abs}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);
  });

  it('an import that throws synchronously at module load is reported with phase import, not resolve', async () => {
    const boom = writeModule('boom-import.mjs', "throw new Error('boom-import');\n");
    const manifestPath = writeManifest(`
plugins:
  - id: boomimport
    name: ${boom}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'boomimport', phase: 'import' });
    expect(report.failed[0].error).toContain('boom-import');
  });

  // No standing regression test for "a module whose body never finishes
  // (top-level await) makes the bare `import()` hang loadPlugins forever" —
  // the only way to express that in ESM is top-level await on an
  // unresolved/long-delayed Promise, and under `bun test --parallel` (which
  // `bun run test:server` always uses) that was observed to resolve
  // near-instantly instead of blocking, for a dynamically `import()`ed file
  // path, regardless of file count — reproduced with just this one file.
  // The `hanging apply()` test below (a Promise returned from a function
  // call, no top-level await) is unaffected, so this looks like a Bun
  // TLA-under-`--parallel` quirk specific to dynamic file imports, not a bug
  // in `withTimeout`. The fix itself (`withTimeout(import(resolvedPath), …)`
  // in loadPlugins) was verified by manually reverting it to a bare `await
  // import(resolvedPath)` and confirming the equivalent test then hung for
  // the full 5s isolated-run budget instead of failing.

  it('a module with no apply() export at all is reported as failed, not silently skipped', async () => {
    const noApply = writeModule('no-apply.mjs', 'export const notApply = 1;\n');
    const manifestPath = writeManifest(`
plugins:
  - id: noapply
    name: ${noApply}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'noapply', phase: 'import' });
    expect(report.failed[0].error).toContain('apply()');
  });

  it('order increments per successfully loaded row, in manifest order', async () => {
    const a = writeModule('order-a.mjs', 'export async function apply() {}\n');
    const b = writeModule('order-b.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: aa
    name: ${a}
  - id: bb
    name: ${b}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(2);
    expect(report.loaded[0]).toMatchObject({ id: 'aa', order: 0 });
    expect(report.loaded[1]).toMatchObject({ id: 'bb', order: 1 });
  });

  it('a manifest that fails to parse returns a report with manifestError set, and does not throw', async () => {
    const manifestPath = path.join(tmpDir, 'poison.yml');
    fs.writeFileSync(manifestPath, 'plugins: [\n', 'utf-8');

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(typeof report.manifestError).toBe('string');
    expect(report.manifestError).toBeTruthy();
    expect(report.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a plugin whose apply() times out cannot register after the fact — the context is revoked', async () => {
    resetHarnesses();
    // A shape-valid harness payload — the real context.ts registrar requires
    // 8 function fields before it even checks liveness. An invalid payload
    // (e.g. just `{ id: 'sneaky' }`) would throw for that reason regardless
    // of revocation, and the test would pass for the wrong reason.
    const late = writeModule(
      'late-register.mjs',
      `const noop = () => {};
       export function apply(ctx) {
         return new Promise((resolve) => {
           setTimeout(() => {
             try {
               ctx.harnesses.register({
                 id: 'sneaky',
                 newSessionId: noop,
                 buildLaunchCommand: noop,
                 buildResumeCommand: noop,
                 buildContinueCommand: noop,
                 installHooks: noop,
                 uninstallHooks: noop,
                 resolveFlags: noop,
                 validateSettings: noop,
               });
             } catch {}
             resolve();
           }, 150);
         });
       }\n`,
    );
    const manifestPath = writeManifest(`
plugins:
  - id: late
    name: ${late}
`);

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      applyTimeoutMs: 10,
    });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'late', phase: 'apply' });

    // Let the plugin's late continuation actually run and attempt to
    // register — proving the revoke, not just the timeout, is what stops it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listHarnesses().some((h) => h.id === 'late:sneaky')).toBe(false);

    resetHarnesses();
  });
});

describe('loadPlugins module + context defaults', () => {
  it('accepts a plugin that hangs apply() off a default export', async () => {
    const abs = writeModule('default-plugin.mjs', 'export default { apply() {} };\n');
    const manifestPath = writeManifest(`
plugins:
  - id: defplug
    name: ${abs}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0].id).toBe('defplug');
  });

  it('hands apply() a real context, not a silent no-op', async () => {
    // The default makeContext must be the real createPluginContext: a stub
    // whose registrars do nothing would report this plugin as loaded while
    // registering nothing. This row declares no grants, so ctx.records.query()
    // (an ungated read) works while ctx.records.put() (gated on records.write)
    // throws "not granted" — the cheapest observable proof the real context,
    // with its real grant wiring, arrived.
    const abs = writeModule(
      'ctx-plugin.mjs',
      `export async function apply(ctx) {
         let queryWorks = false;
         try { await ctx.records.query('x'); queryWorks = true; } catch {}
         let putThrowsNotGranted = false;
         try { await ctx.records.put('x', 1); }
         catch (err) { putThrowsNotGranted = /not granted/.test(String(err)); }
         globalThis.__octomuxCtxProbe = {
           id: ctx.id,
           queryWorks,
           putThrowsNotGranted,
         };
       }\n`,
    );
    const manifestPath = writeManifest(`
plugins:
  - id: ctxplug
    name: ${abs}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect((globalThis as Record<string, unknown>).__octomuxCtxProbe).toEqual({
      id: 'ctxplug',
      queryWorks: true,
      putThrowsNotGranted: true,
    });
    delete (globalThis as Record<string, unknown>).__octomuxCtxProbe;
  });
});

describe('capability grants (SHR-259)', () => {
  afterEach(() => {
    resetMountedPlugins();
    resetHarnesses();
    resetPluginRoutes();
    resetPluginGrants();
  });

  const harnessSource = (id: string) =>
    `export async function apply(ctx) {
       ctx.harnesses.register({ id: '${id}', displayName: '${id}', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) });
     }\n`;

  it('a row with no grants key whose apply() calls a gated registrar fails with phase apply, naming the plugin and the capability', async () => {
    const abs = writeModule('no-grants.mjs', harnessSource('v1'));
    const manifestPath = writeManifest(`
plugins:
  - id: nogrants
    name: ${abs}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'nogrants', phase: 'apply' });
    expect(report.failed[0].error).toContain('nogrants');
    expect(report.failed[0].error).toContain('harnesses.register');
  });

  it('a row that declares the grant loads, and LoadReport.grants reflects what was granted', async () => {
    const abs = writeModule('with-grant.mjs', harnessSource('v1'));
    const manifestPath = writeManifest(`
plugins:
  - id: withgrant
    name: ${abs}
    grants: [harnesses.register]
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    expect(report.grants).toEqual({ withgrant: ['harnesses.register'] });
    expect(report.pendingGrants).toBeUndefined();
  });

  it('a widened grant on a second load is reported in pendingGrants and withheld, while the plugin still loads with its previously-acknowledged set', async () => {
    const abs = writeModule('widen.mjs', harnessSource('v1'));
    const manifestPath = writeManifest(`
plugins:
  - id: widenplug
    name: ${abs}
    grants: [harnesses.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(first.grants).toEqual({ widenplug: ['harnesses.register'] });
    expect(first.pendingGrants).toBeUndefined();

    // A plugin update (or a hand-edit) widens the declared grants without
    // anyone running `octomux plugins approve` yet.
    fs.writeFileSync(
      manifestPath,
      `
plugins:
  - id: widenplug
    name: ${abs}
    grants: [harnesses.register, http.route]
`,
      'utf-8',
    );

    const second = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    // Still loads — the plugin's apply() never touches ctx.http.route, so
    // the withheld capability is never actually exercised this boot.
    expect(second.failed).toEqual([]);
    expect(second.loaded).toHaveLength(1);
    expect(second.grants).toEqual({ widenplug: ['harnesses.register'] });
    expect(second.pendingGrants).toEqual({ widenplug: ['http.route'] });
  });
});

describe('ctx.services mount-time resolution (SHR-260)', () => {
  afterEach(() => {
    resetMountedPlugins();
    resetPluginGrants();
    resetServices();
  });

  it('a consumer listed BEFORE its provider in the manifest still resolves', async () => {
    const consumer = writeModule(
      'services-consumer.mjs',
      "export async function apply(ctx) { ctx.services.require('chat.send'); }\n",
    );
    const provider = writeModule(
      'services-provider.mjs',
      "export async function apply(ctx) { ctx.services.provide('chat.send', { send: () => {} }); }\n",
    );
    const manifestPath = writeManifest(`
plugins:
  - id: consumer
    name: ${consumer}
  - id: provider
    name: ${provider}
    grants: [services.provide]
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toEqual([]);
    expect(report.loaded.map((p) => p.id).sort()).toEqual(['consumer', 'provider']);
  });

  it('an unmet requirement fails only the consumer, naming the plugin and the service', async () => {
    const consumer = writeModule(
      'services-lonely-consumer.mjs',
      "export async function apply(ctx) { ctx.services.require('chat.send'); }\n",
    );
    const ok = writeModule('services-unrelated-ok.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: lonelyconsumer
    name: ${consumer}
  - id: unrelatedok
    name: ${ok}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded.map((p) => p.id)).toEqual(['unrelatedok']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'lonelyconsumer', phase: 'apply' });
    expect(report.failed[0].error).toContain('lonelyconsumer');
    expect(report.failed[0].error).toContain('chat.send');
  });

  it('cascades: unmounting a provider for its own unmet requirement strands its consumer too', async () => {
    // A provides "x" but requires "y", which nothing provides — A must be
    // unmounted. B requires "x", which only A provided — B must be unmounted
    // as a consequence, in a second pass.
    const a = writeModule(
      'services-cascade-a.mjs',
      "export async function apply(ctx) { ctx.services.provide('x', {}); ctx.services.require('y'); }\n",
    );
    const b = writeModule(
      'services-cascade-b.mjs',
      "export async function apply(ctx) { ctx.services.require('x'); }\n",
    );
    const manifestPath = writeManifest(`
plugins:
  - id: cascadea
    name: ${a}
    grants: [services.provide]
  - id: cascadeb
    name: ${b}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.loaded).toEqual([]);
    expect(report.failed.map((f) => f.id).sort()).toEqual(['cascadea', 'cascadeb']);
  });

  it('order has no gaps after a services failure removes a middle plugin', async () => {
    const ok1 = writeModule('services-order-ok1.mjs', 'export async function apply() {}\n');
    const badConsumer = writeModule(
      'services-order-bad.mjs',
      "export async function apply(ctx) { ctx.services.require('nope'); }\n",
    );
    const ok2 = writeModule('services-order-ok2.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: ordok1
    name: ${ok1}
  - id: ordbad
    name: ${badConsumer}
  - id: ordok2
    name: ${ok2}
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].id).toBe('ordbad');
    expect(report.loaded).toHaveLength(2);
    expect(report.loaded[0]).toMatchObject({ id: 'ordok1', order: 0 });
    expect(report.loaded[1]).toMatchObject({ id: 'ordok2', order: 1 });
  });
});

describe('unloadPlugin / reloadPlugin', () => {
  afterEach(() => {
    resetMountedPlugins();
    resetHarnesses();
    resetPluginRoutes();
    resetRecords();
    resetPluginGrants();
  });

  it('reloadPlugin mounts a plugin that was not previously loaded', async () => {
    const abs = writeModule(
      'reload-fresh.mjs',
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
    );
    const manifestPath = writeManifest(`
plugins:
  - id: reloadfresh
    name: ${abs}
    grants: [harnesses.register]
`);

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'reloadfresh',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.id).toBe('reloadfresh');
    }
    expect(getHarness('reloadfresh:v1').id).toBe('reloadfresh:v1');
    expect(getMountedPlugin('reloadfresh')).toBeDefined();
  });

  it('reloadPlugin on an already-mounted plugin unmounts the old registrations and re-evaluates the edited source (cache-busted, not served stale)', async () => {
    const modPath = path.join(tmpDir, 'reload-hot.mjs');
    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: reloadhot
    name: ${modPath}
    grants: [harnesses.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(getHarness('reloadhot:v1').id).toBe('reloadhot:v1');

    // Edit the source on disk — v2 replaces v1.
    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v2', displayName: 'V2', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'reloadhot',
    });

    expect(result.ok).toBe(true);
    // Old registration is gone — proves unmount actually ran before remount.
    expect(() => getHarness('reloadhot:v1')).toThrow();
    // New registration is present — proves the edited file was re-evaluated,
    // not served from the ESM module cache under the same resolved path.
    expect(getHarness('reloadhot:v2').id).toBe('reloadhot:v2');
  });

  it('reloadPlugin refuses a plugin not present in the manifest', async () => {
    const manifestPath = writeManifest(`plugins: []\n`);
    const result = await reloadPlugin({ manifestPath, resolveFrom: nodeModulesDir, id: 'ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no plugin with id/);
  });

  it('reloadPlugin refuses a disabled row without mounting it', async () => {
    const abs = writeModule('reload-disabled.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: reloaddisabled
    name: ${abs}
    disabled: true
`);
    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'reloaddisabled',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disabled/);
    expect(getMountedPlugin('reloaddisabled')).toBeUndefined();
  });

  it('reloadPlugin refuses to unmount+remount a plugin that registered an apiRouter workflow', async () => {
    const abs = writeModule(
      'reload-unloadable.mjs',
      "export async function apply(ctx) { ctx.workflows.register({ kind: 'legacy', displayName: 'Legacy', surfaces: ['feed'], apiRouter: () => {} }); }\n",
    );
    const manifestPath = writeManifest(`
plugins:
  - id: reloadunloadable
    name: ${abs}
    grants: [workflows.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(getWorkflow('reloadunloadable:legacy')).toBeDefined();

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'reloadunloadable',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unloadable).toBe(false);
      expect(result.reason).toMatch(/apiRouter/);
    }
    // Untouched — refusal happened before any teardown.
    expect(getWorkflow('reloadunloadable:legacy')).toBeDefined();
    expect(getMountedPlugin('reloadunloadable')).toBeDefined();
  });

  it('unloadPlugin tears down a mounted plugin and drops it from the mount table', async () => {
    const abs = writeModule(
      'unload-basic.mjs',
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
    );
    const manifestPath = writeManifest(`
plugins:
  - id: unloadbasic
    name: ${abs}
    grants: [harnesses.register]
`);
    await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(getMountedPlugin('unloadbasic')).toBeDefined();

    const result = await unloadPlugin('unloadbasic');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.released.harnessIds).toEqual(['unloadbasic:v1']);
    }
    expect(() => getHarness('unloadbasic:v1')).toThrow();
    expect(getMountedPlugin('unloadbasic')).toBeUndefined();
  });

  it('unloadPlugin refuses a plugin id that is not currently mounted', async () => {
    const result = await unloadPlugin('never-mounted');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not currently mounted/);
  });

  it('reloadPlugin serializes overlapping calls for the same id — apply() never runs concurrently', async () => {
    // A save landing mid-reload used to fire a second, concurrent
    // reloadPlugin() for the same id (Finding 1). Fire two calls back to
    // back with no await between them and prove the second waits for the
    // first: a module-scope counter tracks how many apply() invocations for
    // THIS id are in flight at once — it must never exceed 1.
    const modPath = path.join(tmpDir, 'racer.mjs');
    fs.writeFileSync(
      modPath,
      `let concurrent = 0;
       export async function apply(ctx) {
         concurrent++;
         globalThis.__racerMaxConcurrent = Math.max(globalThis.__racerMaxConcurrent || 0, concurrent);
         await new Promise((r) => setTimeout(r, 40));
         concurrent--;
         ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) });
       }\n`,
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: racer
    name: ${modPath}
    grants: [harnesses.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(getHarness('racer:v1').id).toBe('racer:v1');

    delete (globalThis as Record<string, unknown>).__racerMaxConcurrent;

    const [r1, r2] = await Promise.all([
      reloadPlugin({ manifestPath, resolveFrom: nodeModulesDir, id: 'racer' }),
      reloadPlugin({ manifestPath, resolveFrom: nodeModulesDir, id: 'racer' }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect((globalThis as Record<string, unknown>).__racerMaxConcurrent).toBe(1);
    expect(getHarness('racer:v1').id).toBe('racer:v1');
    delete (globalThis as Record<string, unknown>).__racerMaxConcurrent;
  });

  it('reloadPlugin restores the previously-working version when the new version fails to apply, and reports restored: true', async () => {
    const modPath = path.join(tmpDir, 'rollback-good.mjs');
    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: rollbackgood
    name: ${modPath}
    grants: [harnesses.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(getHarness('rollbackgood:v1').id).toBe('rollbackgood:v1');

    // A bad dev edit — the new version throws in apply().
    fs.writeFileSync(
      modPath,
      "export async function apply() { throw new Error('bad edit'); }\n",
      'utf-8',
    );

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'rollbackgood',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('bad edit');
      expect(result.restored).toBe(true);
    }
    // The OLD version is live again, not just left un-torn-down — proves the
    // module was actually re-applied against a fresh context.
    expect(getHarness('rollbackgood:v1').id).toBe('rollbackgood:v1');
    expect(getMountedPlugin('rollbackgood')).toBeDefined();
  });

  it('reloadPlugin reports restored: false and leaves nothing mounted when the rollback itself cannot re-apply', async () => {
    // The old module's apply() is only safe to run once (its closure state
    // makes a second call throw) — this is the "genuine restore is not
    // achievable" branch: the result must say so honestly rather than
    // pretend a rollback happened.
    const modPath = path.join(tmpDir, 'rollback-bad.mjs');
    fs.writeFileSync(
      modPath,
      `let calls = 0;
       export async function apply(ctx) {
         calls++;
         if (calls > 1) throw new Error('not idempotent — cannot re-apply');
         ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) });
       }\n`,
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: rollbackbad
    name: ${modPath}
    grants: [harnesses.register]
`);

    const first = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(first.failed).toEqual([]);
    expect(getHarness('rollbackbad:v1').id).toBe('rollbackbad:v1');

    // Edited on disk to a version that fails immediately — forces a rollback
    // attempt against the ORIGINAL module object (still in memory, calls===1).
    fs.writeFileSync(
      modPath,
      "export async function apply() { throw new Error('new version broken'); }\n",
      'utf-8',
    );

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'rollbackbad',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('new version broken');
      expect(result.restored).toBe(false);
    }
    expect(() => getHarness('rollbackbad:v1')).toThrow();
    expect(getMountedPlugin('rollbackbad')).toBeUndefined();
  });

  it('a plugin that registers a route and a record store and THEN throws in apply() leaves nothing registered, so a later reload of the same id succeeds', async () => {
    // Finding 5: before the fix, a partial apply() failure only revoked the
    // context — the route/store registered before the throw leaked forever,
    // `mounted` never got an entry, and the next reload skipped the unmount
    // (mounted.has() === false) and hit "already registered"/"already
    // defined" against those leftovers.
    const modPath = path.join(tmpDir, 'partial-fail.mjs');
    fs.writeFileSync(
      modPath,
      `export async function apply(ctx) {
         ctx.http.route('GET', '/thing', async (_req, res) => res.json({}));
         ctx.records.define({ name: 'observed', scope: 'task', mode: 'append', schema: { type: 'object' } });
         throw new Error('boom after partial registration');
       }\n`,
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: partialfail
    name: ${modPath}
    grants: [http.route, records.define]
`);

    const report = await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ id: 'partialfail', phase: 'apply' });
    // Nothing survives the failed apply() — the route it registered before
    // throwing is already gone, and the plugin was never added to `mounted`.
    expect(listPluginRoutes('partialfail')).toEqual([]);
    expect(getMountedPlugin('partialfail')).toBeUndefined();

    // Fix the source (no throw) and reload — must succeed, not error with
    // "already registered" / "already defined" against the failed attempt's
    // leftovers.
    fs.writeFileSync(
      modPath,
      `export async function apply(ctx) {
         ctx.http.route('GET', '/thing', async (_req, res) => res.json({}));
         ctx.records.define({ name: 'observed', scope: 'task', mode: 'append', schema: { type: 'object' } });
       }\n`,
      'utf-8',
    );

    const result = await reloadPlugin({
      manifestPath,
      resolveFrom: nodeModulesDir,
      id: 'partialfail',
    });

    expect(result.ok).toBe(true);
    expect(listPluginRoutes('partialfail')).toEqual(['GET /thing']);
  });

  it('broadcasts plugin:ui-updated on a successful mount', async () => {
    const abs = writeModule('broadcast-mount.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: broadcastmount
    name: ${abs}
`);

    const events: unknown[] = [];
    const unsubscribe = subscribeServerEvents((event) => events.push(event));
    let result;
    try {
      result = await reloadPlugin({
        manifestPath,
        resolveFrom: nodeModulesDir,
        id: 'broadcastmount',
      });
    } finally {
      unsubscribe();
    }

    expect(result.ok).toBe(true);
    expect(events).toContainEqual({
      type: 'plugin:ui-updated',
      payload: { pluginId: 'broadcastmount' },
    });
  });
});

/** Polls `check` until it returns true or `timeoutMs` elapses. Real timers
 *  only — `fs.watch` is real OS filesystem-event delivery, which fake timers
 *  can't simulate at all. */
async function waitUntil(check: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!check()) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

describe('watchLocalPlugins', () => {
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    resetMountedPlugins();
    resetHarnesses();
  });

  it('reloads an absolute-path (local dev) plugin on a debounced file save', async () => {
    const modPath = path.join(tmpDir, 'watch-hot.mjs');
    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: watchhot
    name: ${modPath}
    grants: [harnesses.register]
`);

    await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });
    expect(getHarness('watchhot:v1').id).toBe('watchhot:v1');

    const stop = watchLocalPlugins({ manifestPath, resolveFrom: nodeModulesDir, debounceMs: 20 });
    stops.push(stop);
    // fs.watch's underlying OS watch takes a moment to actually attach after
    // fs.watch() returns — writing immediately can race that and miss the
    // event entirely. A short settle delay before the write is standard
    // practice for fs.watch-based tests, not a fixed sleep waiting for the
    // reload itself (that part still polls via waitUntil below).
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v2', displayName: 'V2', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );

    await waitUntil(() => {
      try {
        return getHarness('watchhot:v2').id === 'watchhot:v2';
      } catch {
        return false;
      }
    });
    expect(() => getHarness('watchhot:v1')).toThrow();
  });

  it('ignores disabled and non-local (bare-name) rows — no reload attempt, no crash', async () => {
    const abs = writeModule('watch-disabled.mjs', 'export async function apply() {}\n');
    const manifestPath = writeManifest(`
plugins:
  - id: watchdisabled
    name: ${abs}
    disabled: true
  - id: watchbare
    name: some-bare-package-name
`);

    // Must not throw even though `watchbare`'s "directory" doesn't exist and
    // `watchdisabled` is skipped outright.
    const stop = watchLocalPlugins({ manifestPath, resolveFrom: nodeModulesDir, debounceMs: 20 });
    stops.push(stop);

    fs.writeFileSync(abs, 'export async function apply(ctx) { ctx.effect(() => {}); }\n', 'utf-8');
    await new Promise((r) => setTimeout(r, 100));
    expect(getMountedPlugin('watchdisabled')).toBeUndefined();
  });

  it('stop() closes every watcher — a save afterward triggers no reload', async () => {
    const modPath = path.join(tmpDir, 'watch-stop.mjs');
    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v1', displayName: 'V1', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );
    const manifestPath = writeManifest(`
plugins:
  - id: watchstop
    name: ${modPath}
    grants: [harnesses.register]
`);
    await loadPlugins({ manifestPath, resolveFrom: nodeModulesDir });

    const stop = watchLocalPlugins({ manifestPath, resolveFrom: nodeModulesDir, debounceMs: 20 });
    stop(); // closed before any save

    fs.writeFileSync(
      modPath,
      "export async function apply(ctx) { ctx.harnesses.register({ id: 'v2', displayName: 'V2', sessionIdMode: 'orchestrator-assigned', newSessionId: () => 'x', buildLaunchCommand: () => '', buildResumeCommand: () => '', buildContinueCommand: () => null, installHooks: async () => {}, uninstallHooks: async () => {}, resolveFlags: () => '', validateSettings: () => ({}) }); }\n",
      'utf-8',
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(() => getHarness('watchstop:v2')).toThrow();
    expect(getHarness('watchstop:v1').id).toBe('watchstop:v1');
  });
});
