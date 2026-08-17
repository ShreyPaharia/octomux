import { describe, it, expect, beforeEach, afterEach, vi, mock, spyOn } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPlugins } from './loader.js';
import { manifestPath as defaultManifestPath } from './paths.js';
import { listHarnesses, resetHarnesses } from '../harnesses/registry.js';

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
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
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

    // A real 10ms timer, not fake timers. loadPlugins awaits real async work
    // (barrel imports, then a dynamic import of the plugin) BEFORE it reaches
    // the setTimeout, so under fake timers `advanceTimersByTimeAsync` runs to
    // completion before the timer is ever scheduled — and the loader then
    // hangs forever on a timer that will never fire. 10ms of wall clock is
    // cheaper than the ordering hazard.
    const report = await loadPlugins({
      manifestPath,
      resolveFrom: nodeModulesDir,
      applyTimeoutMs: 10,
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
    // registering nothing. ctx.kv throws by design until storage lands, which
    // is the cheapest observable proof the real context arrived.
    const abs = writeModule(
      'ctx-plugin.mjs',
      `export function apply(ctx) {
         globalThis.__octomuxCtxProbe = {
           id: ctx.id,
           kvThrows: (() => { try { ctx.kv.get('x'); return false; } catch { return true; } })(),
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
      kvThrows: true,
    });
    delete (globalThis as Record<string, unknown>).__octomuxCtxProbe;
  });
});
