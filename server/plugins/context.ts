/**
 * Builds the `PluginContext` a plugin's `apply()`/`reconcile()` receives.
 *
 * One context per plugin id — `server/plugins/loader.ts` (owned by a sibling
 * task) is expected to call `createPluginContext(row.id)` once per manifest
 * row and hand the result to that plugin only. Nothing here is shared mutable
 * state across plugins except the underlying registries, which already
 * namespace by qualified id.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { childLogger } from '../logger.js';
import { getPluginSettings, updatePluginSettings } from '../settings.js';
import { qualify } from './qualify.js';
import { registerPluginWorkflow } from '../workflows/registry.js';
import { registerProvider } from '../integrations/registry.js';
import { registerHarness, getHarness } from '../harnesses/registry.js';
import { registerCompute } from '../compute/registry.js';
import { registerSurface } from '../surfaces/index.js';
import { registerPluginRoute } from './http-registry.js';
import { defineFactType, putFact, readFacts, watchFacts } from './facts.js';
import { defineCollection, putRecord, queryCollection, watchCollection } from './collections.js';
import { kvGet, kvSet, kvDel, kvList, kvBegin, kvEnd, kvInterrupted } from './kv.js';
import { listSecrets, resolveSecrets } from '../secrets/store.js';
import { registerPluginUiPanel } from './ui-registry.js';
import { listCatalog } from './catalog.js';
import { writeTaskArtifact, listTaskArtifacts, toArtifactEntry } from '../artifact-task.js';
import { setPluginGrants, clearPluginGrants, assertGranted } from './grants.js';
import { registerPolicyHook } from './policy.js';
import { runAgentSession } from '../agent-session/session.js';
import { ptySubstrate } from '../agent-session/substrate-pty.js';
import { createFanOutApi, abortPluginFanOuts } from './fanout.js';
import type {
  PluginContext,
  PluginSettingsScope,
  PluginKv,
  WorkflowRegistrar,
  IntegrationRegistrar,
  HarnessRegistrar,
  ComputeRegistrar,
  SurfaceRegistrar,
  HttpRegistrar,
  FactsRegistrar,
  CollectionsRegistrar,
  CollectionDefinition,
  QuerySpec,
  ArtifactsApi,
  SecretsApi,
  AgentRunner,
  AgentRunOptions,
  UiRegistrar,
  PolicyRegistrar,
  FanOutApi,
  FanOutSpec,
  PluginCapability,
  PluginWorkflow,
  PluginIntegrationProvider,
  PluginHarness,
  PluginCompute,
  SurfaceDefinition,
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
import type { ComputeProvider } from '../compute/types.js';

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

  // Identifies THIS mount for the `ctx.kv` crash-recovery marks (begin/end/
  // interrupted). One per `createPluginContext()` call — a fresh mount after
  // a crash or a hot reload gets a fresh id, so `interrupted()` correctly
  // sees whatever the PREVIOUS mount left stamped and never sees its own.
  const kvMountId = nanoid(12);

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

  const compute: ComputeRegistrar = {
    register(p: PluginCompute) {
      assertLive('compute.register');
      assertGranted(id, 'compute.register');
      const localKind = requireLocalId(p, 'kind', 'compute.register');
      // `create` is guarded because `sessionFor()` dereferences it
      // unconditionally on every task launch — same reasoning as the harness
      // required-fn fields above. `resume` is optional: the host falls back
      // to `create()` when it's absent.
      requireFunctionField(p, 'create', 'compute.register');
      requireOptionalFunctionField(p, 'resume', 'compute.register');
      registerCompute({
        ...(p as unknown as ComputeProvider),
        kind: qualify(id, localKind),
      });
    },
  };

  const surfaces: SurfaceRegistrar = {
    register(s: SurfaceDefinition) {
      assertLive('surfaces.register');
      assertGranted(id, 'surfaces.register');
      const payload = s as unknown as Record<string, unknown>;
      const localKind = requireLocalId(payload, 'kind', 'surfaces.register');
      requireArrayField(payload, 'renderers', 'surfaces.register');
      // `render` is REQUIRED here even though `SurfaceDefinition.render` is
      // typed optional — core's `web` omits it because the browser owns
      // rendering and reads the binding table straight off the API, but a
      // plugin surface has no client of ours to delegate to. A plugin
      // surface with no `render` is a bug, not a mode, so it fails loudly
      // here rather than silently rendering nothing forever.
      requireFunctionField(payload, 'render', 'surfaces.register');
      // Absent `prompt` means read-only — same convention as `compute`'s
      // optional `resume`.
      requireOptionalFunctionField(payload, 'prompt', 'surfaces.register');
      registerSurface({ ...s, kind: qualify(id, localKind) });
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

  const collections: CollectionsRegistrar = {
    define(def: CollectionDefinition) {
      assertLive('collections.define');
      assertGranted(id, 'collections.define');
      requireLocalId(def as unknown as Record<string, unknown>, 'name', 'collections.define');
      requireLocalId(def as unknown as Record<string, unknown>, 'key', 'collections.define');
      defineCollection(id, def);
    },
    // Not `assertLive` — same split as `facts.put`: the revoke guard stops a
    // timed-out apply() from mutating the REGISTRIES, not a healthy plugin
    // from writing a record. Grant-checked regardless.
    put(collection: string, record: unknown) {
      assertGranted(id, 'collections.write');
      return putRecord(id, collection, record);
    },
    // Ungated and unscoped, like facts.read: any plugin may read any
    // collection, its own or a sibling's.
    query(collection: string, q?: QuerySpec) {
      return queryCollection(id, collection, q);
    },
    watch(qualifiedName: string, cb: (record: unknown) => void) {
      assertLive('collections.watch');
      const unsubscribe = watchCollection(qualifiedName, cb);
      // Auto-disposed on unmount, same as facts.watch — and for the same
      // reason: `unregisterPluginCollections` can only reach names this
      // plugin DEFINED, so a watcher on a sibling's collection would
      // otherwise keep firing after this plugin is gone.
      effects.push(unsubscribe);
      return unsubscribe;
    },
  };

  // Not a registrar — a durable store, same as `collections`/`facts`. Writes
  // (`set`/`del`/`begin`/`end`) are grant-checked on `kv.write`; reads
  // (`get`/`list`/`interrupted`) are ungated, same split as
  // `collections.put` vs `collections.query`.
  //
  // Deliberately NOT `assertLive`: like `facts.put`/`collections.put`, a kv
  // write happens long after `apply()` returns — the revoke guard exists to
  // stop a timed-out `apply()` from mutating the live REGISTRIES, and kv is
  // a data store, not a registry.
  //
  // Nothing here is pushed onto the effect stack, and there is no
  // `unregisterPluginKv` for `lifecycle.ts` to call. kv rows deliberately
  // OUTLIVE unmount — a hot-reloaded or restarted plugin must find both its
  // ordinary state and its in-flight checkpoints still there when `apply()`
  // runs again.
  const kv: PluginKv = {
    get<T>(key: string) {
      return kvGet(id, key) as T | undefined;
    },
    set(key: string, value: unknown) {
      assertGranted(id, 'kv.write');
      kvSet(id, key, value);
    },
    del(key: string) {
      assertGranted(id, 'kv.write');
      kvDel(id, key);
    },
    list(prefix?: string) {
      return kvList(id, prefix);
    },
    begin(key: string, value: unknown) {
      assertGranted(id, 'kv.write');
      kvBegin(id, kvMountId, key, value);
    },
    end(key: string) {
      assertGranted(id, 'kv.write');
      kvEnd(id, key);
    },
    interrupted() {
      return kvInterrupted(id, kvMountId);
    },
  };

  // Not a registrar, same as artifacts/agents — nobody needs a different
  // secret store, they need to read one. There is no write path here: a
  // secret is written by a human (UI/CLI/API), never by a plugin, so nothing
  // is registered and there is nothing for unmount to deregister — grants
  // already clear via `clearPluginGrants` on dispose, same as every other
  // capability.
  const secrets: SecretsApi = {
    async list() {
      assertLive('secrets.list');
      return listSecrets().map((s) => s.name);
    },
    async resolve<T>(value: T): Promise<T> {
      assertLive('secrets.resolve');
      assertGranted(id, 'secrets.read');
      return resolveSecrets(value);
    },
  };

  // Not a registrar — a method on ctx, same as facts.put/facts.read. Nobody
  // needs a different artifact implementation; they need to write one. There
  // is no `artifacts.register()` and there will not be.
  const artifacts: ArtifactsApi = {
    // `pluginId` is always this closure's `id`, never anything the caller
    // could pass in `input` — a plugin can write only into its own artifact
    // namespace, same discipline as `facts.put`'s `id` argument to `putFact`.
    // Deliberately NOT gated on `assertLive`, for the same reason
    // `facts.put`/`facts.read` aren't (see the comment there): the revoke
    // guard exists to stop a timed-out `apply()` from mutating the live
    // REGISTRIES, not to stop a healthy plugin from writing output long after
    // `apply()` returned. No teardown either — an artifact is a file in the
    // worktree that outlives the plugin, so nothing here pushes onto
    // `effects`.
    async write(taskId, input) {
      // Granted, but deliberately NOT `assertLive` — see the block comment
      // above. Different questions: a revoked context may still flush output
      // it already earned; an ungranted plugin should never have been writing.
      assertGranted(id, 'artifacts.write');
      return toArtifactEntry(taskId, writeTaskArtifact(taskId, id, input));
    },
    // Unscoped, like facts.read: every plugin's artifacts on the task, not
    // just this plugin's own.
    async list(taskId) {
      return listTaskArtifacts(taskId).map((r) => toArtifactEntry(taskId, r));
    },
  };

  // `ctx.agents` — a headless, structured-output agent run. Same primitive
  // as `services/session-vertical-service.ts`, minus the schedule bookkeeping:
  // this deliberately passes no `run:` option to `runAgentSession`, so the
  // call stays DB-free — a plugin's agent run is not a schedule run and does
  // not get a `runs` row.
  const agents: AgentRunner = {
    async run<T = unknown>(opts: AgentRunOptions): Promise<T> {
      // Gated on `assertLive`, unlike `facts.put`/`artifacts.write` above:
      // those flush output the plugin already earned, but this SPAWNS A NEW
      // SUBPROCESS. A context is revoked both when `apply()` overruns its
      // timeout and — via `disposePluginContext`, which revokes last — on
      // unmount, so this one guard covers "no new agent runs after the
      // plugin is gone" with no extra bookkeeping.
      assertLive('agents.run');
      assertGranted(id, 'agents.run');
      const ephemeral = opts.workspaceDir === undefined;
      const workspaceDir =
        opts.workspaceDir ??
        (await fs.promises.mkdtemp(path.join(os.tmpdir(), `octomux-plugin-${id}-`)));
      try {
        const { result } = await runAgentSession<T>({
          workspaceDir,
          harness: getHarness(null),
          substrate: ptySubstrate,
          input: opts.input,
          outputSchema: opts.outputSchema,
          model: opts.model ?? null,
          timeoutMs: opts.timeoutMs,
        });
        return result;
      } finally {
        // Disposal does not strand an in-flight session and does not block on
        // one either: an in-flight run() keeps going after unmount and
        // settles on its own — `runAgentSession` disposes the process handle
        // and the capture in its own `finally`, and its `timeoutMs` (default
        // 300s) bounds the wait, so nothing leaks and this promise always
        // settles. Unmount only stops NEW runs (via assertLive above); no
        // effect is pushed here, and nothing awaits an in-flight session.
        //
        // Only a dir WE made gets removed; a caller-supplied workspaceDir is
        // the caller's to clean up.
        if (ephemeral) {
          await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };

  const ui: UiRegistrar = {
    panel(binding: UiPanelBinding) {
      assertLive('ui.panel');
      assertGranted(id, 'ui.panel');
      const payload = binding as unknown as Record<string, unknown>;
      requireLocalId(payload, 'slot', 'ui.panel');
      requireLocalId(payload, 'as', 'ui.panel');
      // `fact` is no longer unconditionally required (SHR-275): a binding
      // names EITHER a task-scoped fact type or a durable collection.
      // Deliberately not re-checked here — `registerPluginUiPanel` owns the
      // exactly-one rule so there is one place that decides it, and it has
      // the slot/renderer validation next to it already.
      registerPluginUiPanel(id, binding);
    },
  };

  // Deliberately NOT gated on `assertLive` — same reasoning as `facts.put`
  // above: this is a read, not a registration. A revoked context still has a
  // perfectly good view of what's installed; the revoke guard exists to stop
  // a timed-out apply() from mutating the live registries, not to blind a
  // plugin to them afterward.
  const catalog = { list: () => listCatalog() };
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

  // Not a registrar, same as `artifacts` — nobody needs a different fan-out
  // implementation, they need to run one. `run` is grant-gated here rather
  // than inside the engine so every capability check in the plugin runtime
  // lives in one file; `status`/`list` are ungated reads, matching
  // `facts.read` and `artifacts.list`.
  //
  // Deliberately NOT `assertLive`: a fan-out is work a healthy plugin starts
  // long after `apply()` returned. The revoke guard exists to stop a
  // timed-out `apply()` from mutating the REGISTRIES — same reasoning as
  // `facts.put` above.
  const fanoutApi = createFanOutApi(id);
  const fanout: FanOutApi = {
    run<T = unknown, R = unknown>(spec: FanOutSpec<T, R>) {
      assertGranted(id, 'fanout.run');
      return fanoutApi.run<T, R>(spec);
    },
    status: (runId: string) => fanoutApi.status(runId),
    list: (name?: string) => fanoutApi.list(name),
  };

  const ctx: PluginContext = {
    id,
    logger,
    settings,
    kv,
    workflows,
    integrations,
    harnesses,
    compute,
    surfaces,
    http,
    facts,
    collections,
    artifacts,
    secrets,
    agents,
    ui,
    catalog,
    policy,
    fanout,
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
  // Everything registered through `ctx` is undone on unmount; a fan-out is
  // the one thing that is still *running* at that point. Abort stops the
  // scheduler handing out new items and marks the run `canceled` — it does
  // NOT await in-flight handlers, because a handler may be a multi-minute
  // agent session and unmount must not block on it. The items it was mid-way
  // through go back to `pending`, so a later `{ resume: runId }` picks them up.
  effects.push(() => {
    abortPluginFanOuts(id);
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
