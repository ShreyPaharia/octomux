import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPluginContext } from './context.js';
import {
  pluginRegistrations,
  pluginProvides,
  coreCatalogEntry,
  listCatalog,
  buildCatalog,
} from './catalog.js';
import { resetPluginRoutes } from './http-registry.js';
import { resetPluginUi } from './ui-registry.js';
import { resetSurfaces, registerCoreSurfaces } from '../surfaces/index.js';
// SHR-259: every gated registrar denies a plugin with no recorded grants.
// These tests exercise the catalog, not the grant model, so grant everything.
import { setPluginGrants, PLUGIN_CAPABILITIES } from './grants.js';
import { resetFacts } from './facts.js';
import { resetHarnesses, registerHarness } from '../harnesses/registry.js';
import { resetProviders } from '../integrations/registry.js';
import { loadPlugins, resetMountedPlugins } from './loader.js';
import { claudeCodeHarness } from '../harnesses/claude-code.js';
import type { LoadReport } from '@octomux/plugin-api';

// `workflows/registry.ts` has no resetWorkflows() (deliberate — presets.ts
// relies on the registry never being wiped mid-process, see lifecycle.test.ts's
// same note). Every workflow kind this file registers is namespaced under a
// distinctly-prefixed plugin id, so a leak across tests can't collide with a
// real kind.

beforeEach(() => {
  resetPluginRoutes();
  resetPluginUi();
  resetFacts();
  resetHarnesses();
  resetProviders();
  resetMountedPlugins();
  // context.ts imports `../surfaces/index.js`, whose module scope registers
  // + freezes the four core surfaces as a side effect the first time
  // anything in this process imports it — reset then re-register so each
  // test starts from that same clean, core-only state.
  resetSurfaces();
  registerCoreSurfaces();
});

describe('pluginRegistrations', () => {
  it("picks up only the target plugin's qualified entries, ignoring core and a sibling plugin", () => {
    registerHarness(claudeCodeHarness); // core, bare id — must never leak in

    const mine =
      (setPluginGrants('cat-mine', PLUGIN_CAPABILITIES), createPluginContext('cat-mine'));
    mine.http.route('GET', '/thing', async (_req, res) => res.json({}));
    mine.workflows.register({ kind: 'k', displayName: 'K', surfaces: ['feed'] });
    mine.harnesses.register({
      id: 'h',
      displayName: 'H',
      newSessionId: () => 'x',
      buildLaunchCommand: () => '',
      buildResumeCommand: () => '',
      buildContinueCommand: () => null,
      installHooks: async () => {},
      uninstallHooks: async () => {},
      resolveFlags: () => '',
      validateSettings: () => ({}),
    });
    mine.integrations.register({
      kind: 'i',
      events: [],
      validate: () => ({ ok: true }),
      handler: async () => {},
    });
    mine.facts.define({ type: 'observed', schema: { type: 'object' } });
    mine.ui.panel({ slot: 'task.panel', fact: 'observed', as: 'json' });
    mine.surfaces.register({ kind: 's', renderers: [], render: () => undefined });

    const sibling =
      (setPluginGrants('cat-sibling', PLUGIN_CAPABILITIES), createPluginContext('cat-sibling'));
    sibling.http.route('GET', '/other', async (_req, res) => res.json({}));
    sibling.workflows.register({ kind: 'k', displayName: 'K', surfaces: ['feed'] });
    sibling.harnesses.register({
      id: 'h',
      displayName: 'H',
      newSessionId: () => 'x',
      buildLaunchCommand: () => '',
      buildResumeCommand: () => '',
      buildContinueCommand: () => null,
      installHooks: async () => {},
      uninstallHooks: async () => {},
      resolveFlags: () => '',
      validateSettings: () => ({}),
    });

    const reg = pluginRegistrations('cat-mine');
    expect(reg.workflowKinds).toEqual(['cat-mine:k']);
    expect(reg.harnessIds).toEqual(['cat-mine:h']);
    expect(reg.providerKinds).toEqual(['cat-mine:i']);
    expect(reg.routes).toEqual(['GET /thing']);
    expect(reg.uiSlots).toEqual(['task.panel']);
    expect(reg.factTypes).toEqual(['cat-mine:observed']);
    expect(reg.surfaceKinds).toEqual(['cat-mine:s']);
  });
});

describe('pluginProvides', () => {
  it('flattens in order: workflows, harnesses, integrations, surfaces, routes, ui, facts', () => {
    const ctx =
      (setPluginGrants('cat-order', PLUGIN_CAPABILITIES), createPluginContext('cat-order'));
    ctx.workflows.register({ kind: 'k', displayName: 'K', surfaces: ['feed'] });
    ctx.harnesses.register({
      id: 'h',
      displayName: 'H',
      newSessionId: () => 'x',
      buildLaunchCommand: () => '',
      buildResumeCommand: () => '',
      buildContinueCommand: () => null,
      installHooks: async () => {},
      uninstallHooks: async () => {},
      resolveFlags: () => '',
      validateSettings: () => ({}),
    });
    ctx.integrations.register({
      kind: 'i',
      events: [],
      validate: () => ({ ok: true }),
      handler: async () => {},
    });
    ctx.surfaces.register({ kind: 's', renderers: [], render: () => undefined });
    ctx.http.route('GET', '/thing', async (_req, res) => res.json({}));
    ctx.facts.define({ type: 'observed', schema: { type: 'object' } });
    ctx.ui.panel({ slot: 'task.panel', fact: 'observed', as: 'json' });

    expect(pluginProvides('cat-order')).toEqual([
      'workflow:cat-order:k',
      'harness:cat-order:h',
      'integration:cat-order:i',
      'surface:cat-order:s',
      'route:GET /thing',
      'ui:task.panel',
      'fact:cat-order:observed',
    ]);
  });
});

describe('coreCatalogEntry', () => {
  it('lists core harnesses (claude-code) and NOT a qualified plugin harness', () => {
    registerHarness(claudeCodeHarness);
    const ctx =
      (setPluginGrants('cat-attacker', PLUGIN_CAPABILITIES), createPluginContext('cat-attacker'));
    ctx.harnesses.register({
      id: 'foo',
      displayName: 'Foo',
      newSessionId: () => 'x',
      buildLaunchCommand: () => '',
      buildResumeCommand: () => '',
      buildContinueCommand: () => null,
      installHooks: async () => {},
      uninstallHooks: async () => {},
      resolveFlags: () => '',
      validateSettings: () => ({}),
    });

    const entry = coreCatalogEntry();
    expect(entry.id).toBe('core');
    expect(entry.kind).toBe('core');
    expect(entry.source).toBe('built-in');
    expect(entry.provides).toContain('harness:claude-code');
    expect(entry.provides).not.toContain('harness:cat-attacker:foo');
    expect(entry.provides.some((p) => p.startsWith('harness:cat-attacker'))).toBe(false);
    expect(entry.provides).toContain('surface:web');
    expect(entry.provides).toContain('surface:cli');
    expect(entry.provides).toContain('surface:slack');
    expect(entry.provides).toContain('surface:telegram');
  });
});

describe('listCatalog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-catalog-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes a mounted plugin with the right source, plus the core entry', async () => {
    registerHarness(claudeCodeHarness);

    const modPath = path.join(tmpDir, 'demo-plugin.mjs');
    fs.writeFileSync(
      modPath,
      `export async function apply(ctx) {
         ctx.workflows.register({ kind: 'k', displayName: 'K', surfaces: ['feed'] });
       }\n`,
      'utf-8',
    );
    const manifestPath = path.join(tmpDir, 'octomux.yml');
    fs.writeFileSync(
      manifestPath,
      `plugins:\n  - id: cat-demo\n    name: ${modPath}\n    version: 1.2.3\n    grants: [workflows.register]\n`,
      'utf-8',
    );

    const report = await loadPlugins({
      manifestPath,
      resolveFrom: path.join(tmpDir, 'node_modules'),
    });
    expect(report.failed).toEqual([]);

    const catalog = listCatalog();
    const plugin = catalog.find((e) => e.id === 'cat-demo');
    expect(plugin).toBeDefined();
    expect(plugin?.kind).toBe('plugin');
    expect(plugin?.source).toBe(`${modPath}@1.2.3`);
    expect(plugin?.provides).toContain('workflow:cat-demo:k');

    const core = catalog.find((e) => e.id === 'core');
    expect(core).toBeDefined();
    expect(core?.kind).toBe('core');
    expect(core?.source).toBe('built-in');
  });
});

describe('buildCatalog', () => {
  it('rebuilds plugin entries from a persisted LoadReport, defaulting provides to [] for an older row', () => {
    const report: LoadReport = {
      loaded: [
        {
          id: 'demo',
          name: 'demo-plugin',
          version: '2.0.0',
          resolvedPath: '/node_modules/demo-plugin/index.js',
          order: 0,
          applyMs: 5,
          provides: ['workflow:demo:changelog', 'route:GET /coverage/:task'],
        },
        {
          id: 'legacy',
          name: 'legacy-plugin',
          version: 'unknown',
          resolvedPath: '/node_modules/legacy-plugin/index.js',
          order: 1,
          applyMs: 3,
          // no `provides` — an older persisted report predates this field.
        },
      ],
      failed: [],
      manifestPath: '/fake/octomux.yml',
      safeMode: false,
    };

    const entries = buildCatalog(report);
    expect(entries).toEqual([
      {
        id: 'demo',
        kind: 'plugin',
        provides: ['workflow:demo:changelog', 'route:GET /coverage/:task'],
        source: 'demo-plugin@2.0.0',
      },
      {
        id: 'legacy',
        kind: 'plugin',
        provides: [],
        // `version: 'unknown'` is loader.ts's substitute for a row that
        // declared none — falls back to the resolved path, matching what
        // `listCatalog()` reports live for the same row.
        source: '/node_modules/legacy-plugin/index.js',
      },
    ]);
  });
});
