/**
 * The plugin unmount sequence (SHR-254). Reverses, in reverse registration
 * order, everything a plugin's `apply()` put into the live registries, then
 * runs its `ctx.effect()` teardown stack.
 *
 * Order: routes -> facts -> ui -> the four registries (workflow kinds,
 * harnesses, compute providers, integration providers) -> `ctx.effect()`
 * callbacks. Each step is isolated —
 * one failing step is logged and skipped, never thrown, so a bad teardown
 * can't strand the rest of the sequence (matches the loader's own
 * per-plugin isolation policy).
 */
import { childLogger } from '../logger.js';
import { broadcast } from '../events.js';
import { disposePluginContext } from './context.js';
import { unregisterPluginRoutes, pluginRouteCounts } from './http-registry.js';
import { unregisterPluginFacts } from './facts.js';
import { unregisterPluginUi, listUiContributions } from './ui-registry.js';
import { listWorkflows } from '../workflows/registry.js';
import { unregisterPluginKinds } from '../workflows/presets.js';
import { listHarnesses, unregisterHarness } from '../harnesses/registry.js';
import { listCompute, unregisterCompute } from '../compute/registry.js';
import { listProviders, unregisterProvider } from '../integrations/registry.js';
import type { PluginContext } from '@octomux/plugin-api';

const logger = childLogger('plugins/lifecycle');

export interface UnmountFailure {
  step: string;
  error: string;
}

export interface UnmountReleased {
  routes: number;
  uiContributions: number;
  workflowKinds: string[];
  harnessIds: string[];
  computeKinds: string[];
  providerKinds: string[];
  /** `ctx.effect()` callbacks that ran (successfully or not). */
  effects: number;
}

export interface UnmountReport {
  pluginId: string;
  released: UnmountReleased;
  failures: UnmountFailure[];
}

export interface PluginUnloadability {
  unloadable: boolean;
  /** Set when `unloadable` is false — always present in that case. */
  reason?: string;
}

/**
 * `WorkflowType.apiRouter` hands a plugin an Express `Router`, and express 5
 * cannot unmount one (`server/plugins/http-registry.ts`'s module doc). A
 * plugin that registered a workflow carrying one can never be cleanly
 * unmounted, so it must report that up front rather than let `unmountPlugin`
 * silently leave a live Router mounted while everything else gets torn down.
 *
 * Derived by inspecting the live registry (`listWorkflows()`) rather than by
 * a signal from `server/plugins/context.ts` — that file is pinned/DO NOT
 * EDIT for this task, and every workflow a plugin owns is already qualified
 * `<pluginId>:<kind>`, so a prefix scan is sufficient with no new plumbing.
 */
export function getPluginUnloadability(pluginId: string): PluginUnloadability {
  const prefix = `${pluginId}:`;
  const apiRouterKind = listWorkflows().find(
    (wf) => wf.kind.startsWith(prefix) && wf.apiRouter,
  )?.kind;
  if (apiRouterKind) {
    return {
      unloadable: false,
      reason:
        `plugin "${pluginId}" registered workflow "${apiRouterKind}" with a deprecated ` +
        'WorkflowType.apiRouter — express 5 cannot unmount a Router, so this plugin ' +
        'requires a full server restart, not a hot reload',
    };
  }
  return { unloadable: true };
}

/** Runs `fn`, logging + recording a failure instead of throwing. Returns the
 *  result on success, `undefined` on failure — every caller below treats
 *  `undefined` as "this step released nothing". `fn` may be sync or async —
 *  the `await` inside the `try` catches a rejected promise too, not just a
 *  synchronous throw, so one failing step (sync or async) never strands the
 *  rest of the sequence. */
async function step<T>(
  pluginId: string,
  failures: UnmountFailure[],
  name: string,
  fn: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ step: name, error: message });
    logger.warn({ plugin_id: pluginId, step: name, err }, 'plugin unmount step failed');
    return undefined;
  }
}

/**
 * Tears down everything a plugin registered, in reverse order, and revokes
 * its context. Safe to call even if some steps have nothing to release —
 * every registry's own `unregisterPlugin*` is itself a no-op-safe delete.
 *
 * Does NOT check `getPluginUnloadability()` — that is the caller's job
 * (`server/plugins/loader.ts`'s `unloadPlugin`/`reloadPlugin`), so this
 * function stays usable directly in tests without a live workflow apiRouter
 * to reason about.
 */
export async function unmountPlugin(pluginId: string, ctx: PluginContext): Promise<UnmountReport> {
  const failures: UnmountFailure[] = [];

  // Snapshot counts BEFORE each unregister call — the registries only expose
  // "what's there now", not "what did I just remove".
  const routeCount = pluginRouteCounts()[pluginId] ?? 0;
  await step(pluginId, failures, 'routes', () => unregisterPluginRoutes(pluginId));

  await step(pluginId, failures, 'facts', () => unregisterPluginFacts(pluginId));
  // No public count for fact-type definitions — `facts.ts` is DO NOT EDIT for
  // this task and exposes no getter beyond `unregisterPluginFacts` itself.

  const uiCount = listUiContributions().filter((c) => c.pluginId === pluginId).length;
  await step(pluginId, failures, 'ui', () => unregisterPluginUi(pluginId));

  const workflowKinds =
    (await step(pluginId, failures, 'workflow-kinds', () => unregisterPluginKinds(pluginId))) ?? [];

  const prefix = `${pluginId}:`;
  const harnessIds = listHarnesses()
    .map((h) => h.id)
    .filter((id) => id.startsWith(prefix));
  for (const id of harnessIds) {
    await step(pluginId, failures, `harness:${id}`, () => unregisterHarness(id));
  }

  const computeKinds = listCompute()
    .map((p) => p.kind)
    .filter((kind) => kind.startsWith(prefix));
  for (const kind of computeKinds) {
    await step(pluginId, failures, `compute:${kind}`, () => unregisterCompute(kind));
  }

  const providerKinds = listProviders()
    .map((p) => p.kind)
    .filter((kind) => kind.startsWith(prefix));
  for (const kind of providerKinds) {
    await step(pluginId, failures, `provider:${kind}`, () => unregisterProvider(kind));
  }

  const effectFailures =
    (await step(pluginId, failures, 'effects', () => disposePluginContext(ctx))) ?? [];
  for (const err of effectFailures) {
    failures.push({ step: 'effect', error: err.message });
  }

  const released: UnmountReleased = {
    routes: routeCount,
    uiContributions: uiCount,
    workflowKinds,
    harnessIds,
    computeKinds,
    providerKinds,
    effects: effectFailures.length,
  };

  logger.info(
    { plugin_id: pluginId, released, failure_count: failures.length },
    'plugin unmounted',
  );
  if (failures.length > 0) {
    logger.warn({ plugin_id: pluginId, failures }, 'plugin unmount had failures');
  }

  // SHR-256: a mount/unmount changes what `GET /api/plugin-ui/contributions`
  // returns, so the client must refetch — broadcast unconditionally, even if
  // some steps above failed, since ui-registry's own step still ran.
  broadcast({ type: 'plugin:ui-updated', payload: { pluginId } });

  return { pluginId, released, failures };
}
