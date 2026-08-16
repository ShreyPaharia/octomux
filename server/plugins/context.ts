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

export function createPluginContext(id: string): PluginContext {
  const logger = childLogger(`plugin:${id}`);

  const settings: PluginSettingsScope = {
    get: async <T = Record<string, unknown>>() => (await getPluginSettings(id)) as T,
    update: async (patch) => {
      await updatePluginSettings(id, patch);
    },
  };

  const workflows: WorkflowRegistrar = {
    register(wf: PluginWorkflow) {
      const localKind = requireLocalId(wf, 'kind', 'workflows.register');
      registerPluginWorkflow(qualify(id, localKind), wf as unknown as WorkflowType);
    },
  };

  const integrations: IntegrationRegistrar = {
    register(p: PluginIntegrationProvider) {
      const localKind = requireLocalId(p, 'kind', 'integrations.register');
      registerProvider({
        ...(p as unknown as IntegrationProvider),
        kind: qualify(id, localKind),
      });
    },
  };

  const harnesses: HarnessRegistrar = {
    register(h: PluginHarness) {
      const localId = requireLocalId(h, 'id', 'harnesses.register');
      registerHarness({
        ...(h as unknown as Harness),
        id: qualify(id, localId),
      });
    },
  };

  return {
    id,
    logger,
    settings,
    kv: createKv(id),
    workflows,
    integrations,
    harnesses,
  };
}
