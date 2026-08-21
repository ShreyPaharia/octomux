import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createPluginContext } from './context.js';
import { unmountPlugin, getPluginUnloadability } from './lifecycle.js';
import { resetPluginRoutes, listPluginRoutes } from './http-registry.js';
import { resetPluginUi, listUiContributions } from './ui-registry.js';
import { resetFacts } from './facts.js';
import { registerWorkflow, getWorkflow } from '../workflows/registry.js';
import { resetHarnesses, getHarness, CORE_HARNESS_IDS } from '../harnesses/registry.js';
import { resetCompute, getCompute, CORE_COMPUTE_KINDS } from '../compute/registry.js';
import { resetProviders, getProvider, CORE_PROVIDER_KINDS } from '../integrations/registry.js';
import { subscribeServerEvents } from '../events.js';
import { evaluatePolicy, resetPolicy } from './policy.js';
import { resetPluginGrants } from './grants.js';
import type { PluginContext } from '@octomux/plugin-api';

// `workflows/registry.ts` has no resetWorkflows() (deliberate — presets.ts
// relies on the registry never being wiped mid-process). This file's own
// unregisterPluginKinds/unregisterWorkflow calls (exercised through
// unmountPlugin) clean up after themselves, so no leak guard is needed here.

// Untyped (not `: Harness`/`: IntegrationProvider`) on purpose — the
// registrars take `Record<string, unknown>` (plugin-api's `PluginHarness`/
// `PluginIntegrationProvider`), and a concrete interface type without an
// index signature isn't assignable to that; only a fresh object literal (or
// an untyped inferred return) is.
function fakeHarness(id: string): Record<string, unknown> {
  return {
    id,
    displayName: id,
    sessionIdMode: 'orchestrator-assigned',
    newSessionId: () => 'x',
    buildLaunchCommand: () => '',
    buildResumeCommand: () => '',
    buildContinueCommand: () => null,
    installHooks: async () => {},
    uninstallHooks: async () => {},
    resolveFlags: () => '',
    validateSettings: () => ({}),
    validateAgentName: (name: string) => name,
  };
}

function fakeProvider(kind: string): Record<string, unknown> {
  return {
    kind,
    displayName: kind,
    events: [],
    validate: () => ({}),
    handler: async () => {},
  };
}

function fakeCompute(kind: string): Record<string, unknown> {
  return {
    kind,
    create: async () => ({}) as unknown,
  };
}

beforeEach(() => {
  resetPluginRoutes();
  resetPluginUi();
  resetFacts();
  resetHarnesses();
  resetCompute();
  resetProviders();
  resetPolicy();
  resetPluginGrants();
});

describe('getPluginUnloadability', () => {
  it('is unloadable when the plugin registered no apiRouter workflow', () => {
    registerWorkflow({ kind: 'lc-test:plain', displayName: 'Plain', surfaces: ['feed'] });
    expect(getPluginUnloadability('lc-test')).toEqual({ unloadable: true });
  });

  it('is NOT unloadable, with a reason, when a workflow carries an apiRouter', () => {
    const fakeRouter = { use: () => {} } as unknown as import('express').Router;
    registerWorkflow({
      kind: 'lc-router:legacy',
      displayName: 'Legacy',
      surfaces: ['feed'],
      apiRouter: fakeRouter,
    });
    const result = getPluginUnloadability('lc-router');
    expect(result.unloadable).toBe(false);
    expect(result.reason).toMatch(/apiRouter/);
    expect(result.reason).toMatch(/lc-router:legacy/);
  });
});

describe('unmountPlugin', () => {
  it('releases routes, ui, policy hooks, workflow kinds, harnesses, compute providers, and providers, and runs ctx.effect() in reverse', async () => {
    const pluginId = 'lc-full';
    const ctx = createPluginContext(pluginId, [
      'http.route',
      'workflows.register',
      'harnesses.register',
      'integrations.register',
      'facts.define',
      'ui.panel',
      'policy.intercept',
    ]);

    ctx.http.route('GET', '/thing', async (_req, res) => res.json({}));
    ctx.workflows.register({ kind: 'mine', displayName: 'Mine', surfaces: ['feed'] });
    ctx.harnesses.register(fakeHarness('fake'));
    ctx.compute.register(fakeCompute('fake'));
    ctx.integrations.register(fakeProvider('fake'));
    ctx.facts.define({ type: 'observed', schema: { type: 'object' } });
    ctx.ui.panel({ slot: 'task.panel', fact: 'observed', as: 'json' });
    ctx.policy.intercept('task.launch', () => ({ deny: 'no' }));

    const order: string[] = [];
    ctx.effect(() => {
      order.push('first');
    });
    ctx.effect(() => {
      order.push('second');
    });

    expect(listPluginRoutes(pluginId)).toEqual(['GET /thing']);
    expect(getWorkflow(`${pluginId}:mine`)).toBeDefined();
    expect(getHarness(`${pluginId}:fake`).id).toBe(`${pluginId}:fake`);
    expect(getCompute(`${pluginId}:fake`).kind).toBe(`${pluginId}:fake`);
    expect(getProvider(`${pluginId}:fake`)).toBeDefined();
    expect(listUiContributions().some((c) => c.pluginId === pluginId)).toBe(true);
    expect((await evaluatePolicy('task.launch', { data: {} })).allowed).toBe(false);

    const report = await unmountPlugin(pluginId, ctx);

    expect(report.pluginId).toBe(pluginId);
    expect(report.failures).toEqual([]);
    expect(report.released.routes).toBe(1);
    expect(report.released.uiContributions).toBe(1);
    expect(report.released.policyHooks).toBe(1);
    expect(report.released.workflowKinds).toEqual([`${pluginId}:mine`]);
    expect(report.released.harnessIds).toEqual([`${pluginId}:fake`]);
    expect(report.released.computeKinds).toEqual([`${pluginId}:fake`]);
    expect(report.released.providerKinds).toEqual([`${pluginId}:fake`]);
    expect(report.released.factTypes).toEqual([`${pluginId}:observed`]);
    expect(report.released.effects).toBe(0);

    // Actually released, not just reported.
    expect(listPluginRoutes(pluginId)).toEqual([]);
    expect(getWorkflow(`${pluginId}:mine`)).toBeUndefined();
    expect(() => getHarness(`${pluginId}:fake`)).toThrow();
    expect(() => getCompute(`${pluginId}:fake`)).toThrow();
    expect(getProvider(`${pluginId}:fake`)).toBeUndefined();
    expect(listUiContributions().some((c) => c.pluginId === pluginId)).toBe(false);
    // The policy hook stopped firing — the point falls back to the fast
    // "no hooks registered" path and allows through.
    expect((await evaluatePolicy('task.launch', { data: {} })).allowed).toBe(true);

    // ctx.effect() ran in reverse registration order.
    expect(order).toEqual(['second', 'first']);

    // Context is revoked — further registration attempts throw.
    expect(() => ctx.effect(() => {})).toThrow(/revoked/);
  });

  it('one failing effect does not strand the rest, and is reported as a failure', async () => {
    const pluginId = 'lc-fail';
    const ctx = createPluginContext(pluginId);
    const ran: string[] = [];
    ctx.effect(() => {
      ran.push('ok-1');
    });
    ctx.effect(() => {
      throw new Error('boom');
    });
    ctx.effect(() => {
      ran.push('ok-2');
    });

    const report = await unmountPlugin(pluginId, ctx);

    // Reverse order: ok-2, throw, ok-1 — both survivors still ran.
    expect(ran).toEqual(['ok-2', 'ok-1']);
    expect(report.released.effects).toBe(1);
    expect(report.failures).toEqual([{ step: 'effect', error: 'boom' }]);
  });

  it('never throws, and reports nothing released for a plugin that registered nothing', async () => {
    const ctx = createPluginContext('lc-empty');
    const report = await unmountPlugin('lc-empty', ctx);
    expect(report.failures).toEqual([]);
    expect(report.released).toEqual({
      routes: 0,
      uiContributions: 0,
      policyHooks: 0,
      workflowKinds: [],
      harnessIds: [],
      computeKinds: [],
      providerKinds: [],
      factTypes: [],
      effects: 0,
    });
  });

  it('core harness/compute/provider ids are never touched, even if somehow prefixed the same as a plugin', () => {
    // Guard lives in the registries themselves (unregisterHarness/unregisterCompute/
    // unregisterProvider) — this just pins that unmountPlugin's sweeps only ever
    // target `<pluginId>:` prefixed ids, which core ids never are.
    expect(CORE_HARNESS_IDS.some((id) => id.includes(':'))).toBe(false);
    expect(CORE_COMPUTE_KINDS.some((k) => k.includes(':'))).toBe(false);
    expect(CORE_PROVIDER_KINDS.some((k) => k.includes(':'))).toBe(false);
  });

  it('broadcasts plugin:ui-updated after every unmount', async () => {
    const pluginId = 'lc-broadcast';
    const ctx = createPluginContext(pluginId, ['harnesses.register']);
    ctx.harnesses.register(fakeHarness('v1'));

    const events: unknown[] = [];
    const unsubscribe = subscribeServerEvents((event) => events.push(event));
    try {
      await unmountPlugin(pluginId, ctx);
    } finally {
      unsubscribe();
    }

    // SHR-256: the client's plugin-ui panel list is stale the moment a
    // mount/unmount changes what's registered — this is the signal it
    // refetches on (`src/lib/plugin-ui.ts`).
    expect(events).toContainEqual({ type: 'plugin:ui-updated', payload: { pluginId } });
  });

  it('a step that fails ASYNCHRONOUSLY (a rejected promise, not a sync throw) is caught too, and unmountPlugin still resolves with a report', async () => {
    // `disposePluginContext` throws synchronously when handed a context it
    // did not create ("context was not created by createPluginContext") —
    // but it's an `async function`, so that synchronous throw is delivered
    // as a REJECTED PROMISE to the caller, not a synchronous exception. Only
    // `step()` catching an awaited `fn()` (not just a synchronously-thrown
    // `fn()`) can catch this. Before the fix this rejection propagated
    // straight out of `unmountPlugin`, skipping the trailing log/broadcast/
    // return — this test would see `await unmountPlugin(...)` itself reject.
    const bogusCtx = {} as unknown as PluginContext;

    const report = await unmountPlugin('lc-async-step-fail', bogusCtx);

    const effectsFailure = report.failures.find((f) => f.step === 'effects');
    expect(effectsFailure).toBeDefined();
    expect(effectsFailure?.error).toMatch(/not created by createPluginContext/);
    // Nothing else in the sequence was stranded — routes/ui/etc. still ran and
    // reported normally, exactly as the module's own doc comment promises.
    expect(report.released.routes).toBe(0);
  });
});
