/**
 * Builds the `PluginContext` a plugin's `apply()`/`reconcile()` receives.
 *
 * One context per plugin id — `server/plugins/loader.ts` (owned by a sibling
 * task) is expected to call `createPluginContext(row.id)` once per manifest
 * row and hand the result to that plugin only. Nothing here is shared mutable
 * state across plugins except the underlying registries, which already
 * namespace by qualified id.
 */
import { childLogger } from '../logger.js';
import { getPluginSettings, updatePluginSettings } from '../settings.js';
import { qualify } from './qualify.js';
import { registerPluginWorkflow } from '../workflows/registry.js';
import { registerProvider } from '../integrations/registry.js';
import { registerHarness } from '../harnesses/registry.js';
import { registerPluginRoute } from './http-registry.js';
import { defineFactType, putFact, readFacts, watchFacts } from './facts.js';
import { registerPluginUiPanel } from './ui-registry.js';
import { setPluginGrants, clearPluginGrants, assertGranted } from './grants.js';
import { registerPolicyHook } from './policy.js';
import type {
  PluginContext,
  PluginSettingsScope,
  PluginKv,
  WorkflowRegistrar,
  IntegrationRegistrar,
  HarnessRegistrar,
  HttpRegistrar,
  FactsRegistrar,
  UiRegistrar,
  PolicyRegistrar,
  PluginCapability,
  PluginWorkflow,
  PluginIntegrationProvider,
  PluginHarness,
  Fact,
  FactQuery,
  FactTypeDefinition,
  HttpMethod,
  PluginRouteHandler,
  UiPanelBinding,
  PolicyPoint,
  PolicyHook,
} from '@octomux/plugin-api';
import type { WorkflowType } from '../workflows/types.js';
import type { IntegrationProvider } from '../integrations/types.js';
import type { Harness } from '../harnesses/types.js';

const POLICY_POINTS: readonly PolicyPoint[] = [
  'task.launch',
  'harness.resume',
  'review.publish',
  'integration.send',
];

/**
 * Pulls a registrar's declared local id off the plugin-supplied payload and
 * validates it's actually a non-empty string.
 *
 * `@octomux/plugin-api`'s `PluginWorkflow`/`PluginIntegrationProvider`/
 * `PluginHarness` are typed as `Record<string, unknown>` (the plan keeps
 * plugin-api free of a dependency on the concrete server-side registry
 * types), so nothing stops a plugin from omitting the field. Left
 * unchecked, `qualify(id, undefined)` would coerce `undefined` through
 * `RegExp.test` to the literal string `"undefined"` — which matches
 * `KIND_NAME_RE` and would silently register under `<id>:undefined` instead
 * of failing loudly.
 */
function requireLocalId(payload: Record<string, unknown>, field: string, what: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`plugin registrar: "${what}" requires a non-empty string "${field}" field`);
  }
  return value;
}

/**
 * A registrar's payload is `Record<string, unknown>` at the type level (see
 * `requireLocalId`'s doc comment), so nothing stops a plugin from handing
 * back a truthy non-function for a member core calls unconditionally. The
 * concrete case that motivated this: `WorkflowType.apiRouter` reaches
 * `app.use(wf.apiRouter)` in `server/api.ts` with no further check — against
 * express 5.2.1 that throws `app.use() requires a middleware function` and
 * takes down `createApp()`, well after the plugin was already recorded as
 * `loaded`. Fail here instead, inside the loader's try/catch, so a bad
 * payload becomes a `phase: 'apply'` load-report entry rather than a boot
 * crash with a misleading report.
 *
 * Only members core actually dereferences unconditionally (boot path or a
 * hot path — task launch, hook dispatch, the schedule poller) are guarded.
 * Optional fields nothing calls yet (see the "unwired" doc comments on
 * `Harness`) are left alone — that's the plugin's own business until core
 * grows a caller.
 */
function requireFunctionField(payload: Record<string, unknown>, field: string, what: string): void {
  if (typeof payload[field] !== 'function') {
    throw new Error(`plugin registrar: "${what}" requires a function "${field}" field`);
  }
}

/** Same as `requireFunctionField`, but the field is optional — only checked when present. */
function requireOptionalFunctionField(
  payload: Record<string, unknown>,
  field: string,
  what: string,
): void {
  const value = payload[field];
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`plugin registrar: "${what}" field "${field}", if present, must be a function`);
  }
}

function requireArrayField(payload: Record<string, unknown>, field: string, what: string): void {
  if (!Array.isArray(payload[field])) {
    throw new Error(`plugin registrar: "${what}" requires an array "${field}" field`);
  }
}

/**
 * Required `Harness` members that core calls unconditionally as functions —
 * task launch (`start-task.ts`, `launch.ts`), chat sessions (`chats.ts`),
 * settings merge/validate (`settings.ts`), hook install/uninstall
 * (`hook-token.ts`, `hook-settings.ts`, `cleanup.ts`) and flag resolution
 * (`harness-flags.ts`) all call these with no `typeof` guard of their own.
 * `validateAgentName` is excluded: every call site imports the free function
 * from `harnesses/types.ts` directly, never `harness.validateAgentName()`.
 */
const HARNESS_REQUIRED_FN_FIELDS = [
  'newSessionId',
  'buildLaunchCommand',
  'buildResumeCommand',
  'buildContinueCommand',
  'installHooks',
  'uninstallHooks',
  'resolveFlags',
  'validateSettings',
] as const;

/** Builds the `ctx.kv` stub. Every method throws — W1-D (plugin storage) hasn't landed. */
function createKv(id: string): PluginKv {
  const notAvailable = (method: string): never => {
    throw new Error(
      `ctx.kv.${method}() is not available for plugin "${id}" — ` +
        'the plugin storage task has not landed yet',
    );
  };
  return {
    get: () => notAvailable('get'),
    set: () => notAvailable('set'),
    del: () => notAvailable('del'),
    list: () => notAvailable('list'),
  };
}

/**
 * Maps a live `PluginContext` to the closure that revokes it. Keyed by the
 * context object itself (not the plugin id) so a caller can't revoke a
 * context it was never handed; a `WeakMap` lets the entry die with the
 * context instead of leaking one slot per plugin load for process lifetime.
 */
const revokers = new WeakMap<PluginContext, () => void>();

/**
 * Teardown callbacks a plugin registered via `ctx.effect()`, in registration
 * order. `disposePluginContext()` runs them in REVERSE — the Cordis model,
 * where a plugin's registrations are undone in the opposite order they were
 * made, so a later effect never observes an earlier one already gone.
 *
 * Keyed by the context object for the same reason as `revokers`: a caller
 * can't dispose a context it was never handed, and the entry dies with the
 * context rather than leaking a slot per plugin load for process lifetime.
 */
const effectStacks = new WeakMap<PluginContext, Array<() => void | Promise<void>>>();

export function createPluginContext(
  id: string,
  grants?: readonly PluginCapability[],
): PluginContext {
  // The loader records grants before calling this; a direct caller (tests,
  // other call sites) may pass them inline instead. Omitting the param
  // leaves whatever was already recorded for `id` untouched — a plugin with
  // nothing recorded is denied everything gated, by default.
  if (grants !== undefined) {
    setPluginGrants(id, grants);
  }

  const logger = childLogger(`plugin:${id}`);

  // Flipped by `revokePluginContext()` when the loader's apply() timeout
  // fires. `apply()` itself is never cancelled (see revokePluginContext's
  // doc comment) — this only stops it from registering anything into the
  // live registries after the loader has already moved on and reported it
  // failed. Every registrar below checks this first.
  let live = true;
  const assertLive = (what: string) => {
    if (!live) {
      throw new Error(
        `plugin "${id}": context revoked — ${what} refused because apply() overran its timeout budget`,
      );
    }
  };

  const settings: PluginSettingsScope = {
    get: async <T = Record<string, unknown>>() => (await getPluginSettings(id)) as T,
    update: async (patch) => {
      await updatePluginSettings(id, patch);
    },
  };

  const workflows: WorkflowRegistrar = {
    register(wf: PluginWorkflow) {
      assertLive('workflows.register');
      assertGranted(id, 'workflows.register');
      const localKind = requireLocalId(wf, 'kind', 'workflows.register');
      requireOptionalFunctionField(wf, 'apiRouter', 'workflows.register');
      requireOptionalFunctionField(wf, 'run', 'workflows.register');
      registerPluginWorkflow(qualify(id, localKind), wf as unknown as WorkflowType);
    },
  };

  const integrations: IntegrationRegistrar = {
    register(p: PluginIntegrationProvider) {
      assertLive('integrations.register');
      assertGranted(id, 'integrations.register');
      const localKind = requireLocalId(p, 'kind', 'integrations.register');
      requireFunctionField(p, 'validate', 'integrations.register');
      requireFunctionField(p, 'handler', 'integrations.register');
      requireArrayField(p, 'events', 'integrations.register');
      requireOptionalFunctionField(p, 'test', 'integrations.register');
      registerProvider({
        ...(p as unknown as IntegrationProvider),
        kind: qualify(id, localKind),
      });
    },
  };

  const harnesses: HarnessRegistrar = {
    register(h: PluginHarness) {
      assertLive('harnesses.register');
      assertGranted(id, 'harnesses.register');
      const localId = requireLocalId(h, 'id', 'harnesses.register');
      for (const field of HARNESS_REQUIRED_FN_FIELDS) {
        requireFunctionField(h, field, 'harnesses.register');
      }
      registerHarness({
        ...(h as unknown as Harness),
        id: qualify(id, localId),
      });
    },
  };

  const http: HttpRegistrar = {
    route(method: HttpMethod, path: string, handler: PluginRouteHandler) {
      assertLive('http.route');
      assertGranted(id, 'http.route');
      if (typeof handler !== 'function') {
        throw new Error('plugin registrar: "http.route" requires a function handler');
      }
      registerPluginRoute(id, method, path, handler);
    },
  };

  // Declared before the registrars that push onto it (facts.watch) — see the
  // auto-dispose note there.
  const effects: Array<() => void | Promise<void>> = [];

  const facts: FactsRegistrar = {
    define(def: FactTypeDefinition) {
      assertLive('facts.define');
      assertGranted(id, 'facts.define');
      requireLocalId(def as unknown as Record<string, unknown>, 'type', 'facts.define');
      defineFactType(id, def);
    },
    put(taskId: string, localType: string, payload: unknown) {
      // Deliberately NOT gated on `assertLive`: `put` is a write a plugin makes
      // during normal operation, long after apply() returned. The revoke guard
      // exists to stop a timed-out apply() from mutating the REGISTRIES, not to
      // stop a healthy plugin from logging a fact. It IS grant-checked, though —
      // `facts.put` is a listed capability regardless of the (separate) revoke
      // lifecycle.
      assertGranted(id, 'facts.put');
      return putFact(id, taskId, localType, payload);
    },
    read(taskId: string, opts?: FactQuery) {
      return readFacts(taskId, opts);
    },
    watch(qualifiedType: string, onFact: (fact: Fact) => void) {
      assertLive('facts.watch');
      const unsubscribe = watchFacts(qualifiedType, onFact);
      // Auto-disposed on unmount, as the plugin-api doc promises. This is the
      // ONLY thing that unsubscribes a watcher on a type the plugin does not
      // own: `unregisterPluginFacts(pluginId)` can only reach watchers on types
      // that plugin DEFINED, so a plugin watching `core:diff` or a sibling
      // plugin's type would otherwise keep firing forever after it unmounts.
      // Idempotent — a plugin that also calls the returned unsubscribe itself
      // is fine, `watchFacts` tolerates a double unsubscribe.
      effects.push(unsubscribe);
      return unsubscribe;
    },
  };

  const ui: UiRegistrar = {
    panel(binding: UiPanelBinding) {
      assertLive('ui.panel');
      assertGranted(id, 'ui.panel');
      const payload = binding as unknown as Record<string, unknown>;
      requireLocalId(payload, 'slot', 'ui.panel');
      requireLocalId(payload, 'fact', 'ui.panel');
      requireLocalId(payload, 'as', 'ui.panel');
      registerPluginUiPanel(id, binding);
    },
  };

  const policy: PolicyRegistrar = {
    intercept(point: PolicyPoint, hook: PolicyHook) {
      assertLive('policy.intercept');
      assertGranted(id, 'policy.intercept');
      if (!POLICY_POINTS.includes(point)) {
        throw new Error(
          `plugin registrar: "policy.intercept" got unknown point ${JSON.stringify(point)} ` +
            `(valid: ${POLICY_POINTS.join(', ')})`,
        );
      }
      if (typeof hook !== 'function') {
        throw new Error('plugin registrar: "policy.intercept" requires a function hook');
      }
      registerPolicyHook(id, point, hook);
    },
  };

  const ctx: PluginContext = {
    id,
    logger,
    settings,
    kv: createKv(id),
    workflows,
    integrations,
    harnesses,
    http,
    facts,
    ui,
    policy,
    effect(dispose: () => void | Promise<void>) {
      assertLive('effect');
      if (typeof dispose !== 'function') {
        throw new Error('plugin registrar: "effect" requires a function');
      }
      effects.push(dispose);
    },
  };
  revokers.set(ctx, () => {
    live = false;
  });
  // Pushed onto the effect stack rather than handled as a third WeakMap: it
  // runs LAST (effects run in reverse registration order, and this is the
  // very first thing registered), which is fine — nothing else in teardown
  // depends on the grant record still being present.
  effects.push(() => {
    clearPluginGrants(id);
  });
  effectStacks.set(ctx, effects);
  return ctx;
}

/**
 * Runs a context's `ctx.effect()` callbacks in reverse registration order and
 * revokes the context so nothing it holds can register again.
 *
 * This covers only what the PLUGIN owns — timers, watchers, sockets. Undoing
 * the host-side registrations (routes, kinds, providers, harnesses, UI
 * contributions) is `server/plugins/lifecycle.ts`'s job, which calls this
 * last. Anything the plugin did NOT route through `ctx` cannot be tracked and
 * will not be released; that is a real limit of the model, not an oversight.
 *
 * One effect throwing must not strand the rest: every callback runs, and the
 * failures are returned for the caller to log against the plugin.
 */
export async function disposePluginContext(ctx: PluginContext): Promise<Error[]> {
  const effects = effectStacks.get(ctx);
  if (!effects) {
    throw new Error('disposePluginContext: context was not created by createPluginContext');
  }
  const failures: Error[] = [];
  for (let i = effects.length - 1; i >= 0; i--) {
    try {
      await effects[i]();
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  effects.length = 0;
  revokers.get(ctx)?.();
  return failures;
}

/**
 * Revokes a `PluginContext` so every registrar on it throws instead of
 * reaching the live registries. `server/plugins/loader.ts` calls this from
 * its `apply()`-timeout catch: the timeout races `apply()` but never cancels
 * it (real cancellation needs an `AbortSignal` on `PluginContext`, which
 * isn't worth adding yet — nothing here attempts to stop the plugin's promise,
 * only to stop what it can still do). Without this, a plugin reported
 * `failed` could still land its workflow/provider/harness in the live
 * registry moments later — and `getHarness()` is read live on every task
 * launch (`task-engine/lifecycle/start-task.ts`), so a "failed" plugin would
 * silently keep controlling what command every task runs.
 */
export function revokePluginContext(ctx: PluginContext): void {
  const revoke = revokers.get(ctx);
  if (!revoke) {
    throw new Error('revokePluginContext: context was not created by createPluginContext');
  }
  revoke();
}
