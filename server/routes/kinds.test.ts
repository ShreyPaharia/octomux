/**
 * `GET/PUT/DELETE /api/kinds` — coherence across three preset tiers
 * (built-in, plugin, home). Mounts the router directly (not the full
 * `createApp()`) since these routes don't touch the DB — only
 * `server/workflows/presets.ts`'s filesystem scan.
 */
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';

const { default: request } = await import('supertest');
const { default: fs } = await import('fs');
const { default: path } = await import('path');
const { default: os } = await import('os');
const { router } = await import('./kinds.js');
const { errorMiddleware } = await import('../error-middleware.js');
const { reloadPresets, getPreset } = await import('../workflows/presets.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(errorMiddleware);
  return app;
}

describe('kinds routes — plugin tier', () => {
  let pluginPrefix: string;
  let homeDir: string;
  let manifestFile: string;
  let listed: string[];

  beforeEach(() => {
    pluginPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugin-prefix-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-kinds-'));
    manifestFile = path.join(pluginPrefix, 'octomux.yml');
    listed = [];
    vi.stubEnv('OCTOMUX_PLUGIN_PREFIX', pluginPrefix);
    vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', manifestFile);
    vi.stubEnv('OCTOMUX_KINDS_DIR', homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(pluginPrefix, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    reloadPresets();
  });

  /**
   * Installs a plugin kind AND lists its package in the manifest — the tier
   * only scans packages with an enabled `octomux.yml` row, so writing the
   * files alone contributes nothing. The row `id` is the namespace, so this
   * package's kinds qualify as `<pkg>:<kind>`.
   */
  function writePluginKind(pkg: string, name: string, body: unknown): void {
    const dir = path.join(pluginPrefix, 'node_modules', pkg, 'kinds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body), 'utf-8');
    if (!listed.includes(pkg)) listed.push(pkg);
    const rows = listed.map((p) => `  - id: ${p}\n    name: ${p}`).join('\n');
    fs.writeFileSync(manifestFile, `plugins:\n${rows}\n`, 'utf-8');
  }

  it('GET /api/kinds includes a plugin-tier kind, qualified and tagged', async () => {
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    reloadPresets();

    const res = await request(makeApp()).get('/api/kinds');
    expect(res.status).toBe(200);
    const found = res.body.kinds.find((k: { kind: string }) => k.kind === 'demo:changelog');
    expect(found).toBeDefined();
    expect(found.source).toBe('plugin');
  });

  it('PUT /api/kinds/:kind rejects a qualified id — plugin kinds are read-only via this route', async () => {
    const res = await request(makeApp())
      .put('/api/kinds/demo:changelog')
      .send({ kind: 'demo:changelog', displayName: 'X', execution: 'session' });

    // Express treats `:` in a path segment as part of the param value, so this
    // reaches the handler — and KIND_NAME_RE (no `:`) rejects it before any
    // filesystem write, exactly like it rejects `..` or `/`.
    expect(res.status).toBe(400);
  });

  it('DELETE /api/kinds/:kind on a plugin kind is unreachable (structurally, not just guarded)', async () => {
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    reloadPresets();
    expect(getPreset('demo:changelog')).toBeDefined();

    const res = await request(makeApp()).delete('/api/kinds/demo:changelog');
    expect(res.status).toBe(400);
    // never actually removed
    expect(getPreset('demo:changelog')).toBeDefined();
  });

  it('a plugin kind never shadows a built-in id in the GET listing', async () => {
    writePluginKind('demo', 'weekly-update', {
      kind: 'weekly-update',
      displayName: 'Fake Weekly Update',
      execution: 'session',
    });
    reloadPresets();

    const res = await request(makeApp()).get('/api/kinds');
    const builtin = res.body.kinds.find(
      (k: { kind: string; source: string }) => k.kind === 'weekly-update',
    );
    const plugin = res.body.kinds.find(
      (k: { kind: string; source: string }) => k.kind === 'demo:weekly-update',
    );
    expect(builtin.source).toBe('builtin');
    expect(builtin.displayName).not.toBe('Fake Weekly Update');
    expect(plugin.source).toBe('plugin');
    expect(plugin.displayName).toBe('Fake Weekly Update');
  });
});
