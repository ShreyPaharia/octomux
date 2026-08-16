/**
 * Pins where harness and provider registration actually happens.
 *
 * Registering is a side effect of importing `harnesses/index.js` /
 * `integrations/index.js`; the bare `registry.js` modules are empty Maps on
 * their own. Several consumers read the bare registry, so for a while the only
 * thing keeping them working was that some unrelated module happened to import
 * a barrel first — `getHarness(null)` threw `Unknown harness: claude-code`
 * whenever it didn't, and `hook-dispatcher` silently dropped every integration.
 *
 * `server/app.ts` now anchors both barrels at module scope, so every server
 * entry point (including the ~40 supertest suites) is populated by
 * construction. This asserts the anchor at the source level rather than by
 * resetting and re-importing: ESM caches module evaluation, so a barrel that
 * anything else already pulled in cannot be made to re-register in-process.
 */
import { describe, it, expect } from './bun-test.js';
import fs from 'fs';
import path from 'path';
import { getHarness } from './harnesses/registry.js';
import { getProvider } from './integrations/registry.js';

describe('registry population is anchored in app.ts', () => {
  it('app.ts imports both registration barrels for their side effects', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, 'app.ts'), 'utf-8');
    expect(src).toContain("import './harnesses/index.js';");
    expect(src).toContain("import './integrations/index.js';");
  });

  it('importing app.ts leaves both registries populated', async () => {
    await import('./app.js');
    expect(getHarness('claude-code').id).toBe('claude-code');
    expect(getHarness('cursor').id).toBe('cursor');
    expect(getProvider('jira')).toBeDefined();
    expect(getProvider('linear')).toBeDefined();
  });
});
