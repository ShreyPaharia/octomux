import { describe, it, expect, afterEach, vi } from './bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { loadPlugins } from './plugins/loader.js';
import { listHarnesses, CORE_HARNESS_IDS } from './harnesses/index.js';
import { listProviders, CORE_PROVIDER_KINDS } from './integrations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('server/index.ts boot order', () => {
  // server/index.ts is a top-level boot script with heavy real-world side
  // effects (instance lock file, DB open, HTTP listen, tmux runtime dir) that
  // make executing it directly in a unit test impractical — the same
  // conclusion the plan's own spike S4 reached ("verified by inspection") for
  // this exact contract. This is a source-order regression guard: it fails
  // loudly if a future edit moves loadPlugins() around
  // acquireInstanceLock()/createApp(), which is the one thing THE BOOT-ORDER
  // CONTRACT (plans/2026-08-16-plugin-ecosystem.md) forbids.
  it('calls acquireInstanceLock() before loadPlugins() before createApp()', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');

    const lockIdx = source.indexOf('acquireInstanceLock();');
    const loadPluginsIdx = source.indexOf('await loadPlugins({');
    const createAppIdx = source.indexOf('const app = createApp();');

    expect(lockIdx).toBeGreaterThan(-1);
    expect(loadPluginsIdx).toBeGreaterThan(-1);
    expect(createAppIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(loadPluginsIdx);
    expect(loadPluginsIdx).toBeLessThan(createAppIdx);
  });

  it('getDb() is forced before loadPlugins() runs, so a plugin cannot swallow a migration failure', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');

    const getDbIdx = source.indexOf('getDb();');
    const loadPluginsIdx = source.indexOf('await loadPlugins({');

    expect(getDbIdx).toBeGreaterThan(-1);
    expect(getDbIdx).toBeLessThan(loadPluginsIdx);
  });
});

describe('createApp()', () => {
  it('returns synchronously — ~40 supertest suites call it directly with no await', () => {
    const result = createApp();
    // A Promise would have a `.then`; a real Express app does not.
    expect(typeof (result as unknown as { then?: unknown }).then).not.toBe('function');
    expect(typeof result.use).toBe('function');
    expect(typeof result.listen).toBe('function');
  });
});

describe('OCTOMUX_SAFE_MODE', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('disables plugin manifest rows but leaves core harnesses and providers registered', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-safe-mode-test-'));
    const manifestPath = path.join(tmpDir, 'octomux.yml');
    fs.writeFileSync(
      manifestPath,
      `
plugins:
  - id: whatever
    name: whatever-pkg
`,
    );

    vi.stubEnv('OCTOMUX_SAFE_MODE', '1');

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: path.join(tmpDir, 'node_modules'),
    });

    expect(report.safeMode).toBe(true);
    expect(report.loaded).toEqual([]);
    expect(report.failed).toEqual([]);

    for (const id of CORE_HARNESS_IDS) {
      expect(listHarnesses().some((h) => h.id === id)).toBe(true);
    }
    for (const kind of CORE_PROVIDER_KINDS) {
      expect(listProviders().some((p) => p.kind === kind)).toBe(true);
    }
  });
});
