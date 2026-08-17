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
import type {
  PluginContext,
  PluginSettingsScope,
  PluginKv,
  WorkflowRegistrar,
  IntegrationRegistrar,
  HarnessRegistrar,
  PluginWorkflow,
  PluginIntegrationProvider,
  PluginHarness,
} from '@octomux/plugin-api';
import type { WorkflowType } from '../workflows/types.js';
import type { IntegrationProvider } from '../integrations/types.js';
import type { Harness } from '../harnesses/types.js';

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

export function createPluginContext(id: string): PluginContext {
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
      const localKind = requireLocalId(wf, 'kind', 'workflows.register');
      requireOptionalFunctionField(wf, 'apiRouter', 'workflows.register');
      requireOptionalFunctionField(wf, 'run', 'workflows.register');
      registerPluginWorkflow(qualify(id, localKind), wf as unknown as WorkflowType);
    },
  };

  const integrations: IntegrationRegistrar = {
    register(p: PluginIntegrationProvider) {
      assertLive('integrations.register');
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

  const ctx: PluginContext = {
    id,
    logger,
    settings,
    kv: createKv(id),
    workflows,
    integrations,
    harnesses,
  };
  revokers.set(ctx, () => {
    live = false;
  });
  return ctx;
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
