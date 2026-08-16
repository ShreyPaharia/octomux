import { describe, it, expect, beforeEach, afterEach, vi, mock, spyOn } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPlugins } from './loader.js';
import { manifestPath as defaultManifestPath } from './paths.js';

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

  it('NODE_ENV=test with the unconfigured default manifestPath does zero filesystem work', async () => {
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

    expect(report).toEqual({ loaded: [], failed: [], manifestPath, safeMode: true });
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
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
