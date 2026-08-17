import { describe, it, expect, afterEach, vi } from './bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from './app.js';
import { loadPlugins } from './plugins/loader.js';
import { listHarnesses, CORE_HARNESS_IDS } from './harnesses/index.js';
import { listProviders, CORE_PROVIDER_KINDS } from './integrations/index.js';

// server/index.ts is a top-level boot script with heavy real-world side
// effects (instance lock file, DB open, HTTP listen, tmux runtime dir) that
// make executing it directly in a unit test impractical. The two
// source-text ordering assertions that used to live here (grepping index.ts
// for `acquireInstanceLock()` / `await loadPlugins({` / `const app =
// createApp();` and comparing string offsets) were removed: mutation testing
// showed they're blind to the actual violation (hoisting `const earlyApp =
// createApp()` above the loadPlugins block, or moving `getDb()` after
// loadPlugins while leaving a comment mentioning it, both still passed) and
// brittle against harmless refactors (renaming the `loadPlugins` call's
// options variable flipped them red for no behavioural reason). The
// invariant they were trying to guard — a plugin's apiRouter must be
// registered before createApp() snapshots the workflow registry — is now
// covered behaviourally, through real supertest requests with no source
// inspection, in server/plugins/boot-registration.test.ts.

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
