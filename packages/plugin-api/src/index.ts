/**
 * @octomux/plugin-api — TYPES ONLY. Nothing runtime crosses this boundary.
 *
 * CI assert: dist/index.js must be `export {};` or absent, apart from the
 * `PLUGIN_API_VERSION` const below. See `plans/2026-08-16-plugin-ecosystem.md`
 * ("The envelope" / "Pinned interfaces") — this file is a verbatim copy of
 * the pinned shapes plus the two runtime-facing exports the plan reserves
 * for this package (`PLUGIN_API_VERSION`, `OctomuxPlugin`).
 */

export interface PluginContext {
  readonly id: string; // manifest row id (bare, unqualified)
  readonly logger: PluginLogger;
  readonly settings: PluginSettingsScope;
  readonly kv: PluginKv;
  readonly workflows: WorkflowRegistrar;
  readonly integrations: IntegrationRegistrar;
  readonly harnesses: HarnessRegistrar;
  readonly http: HttpRegistrar;
  readonly facts: FactsRegistrar;
  readonly ui: UiRegistrar;
  readonly policy: PolicyRegistrar;
  /**
   * Registers a teardown callback run when this plugin unmounts, in reverse
   * registration order. Everything registered *through* `ctx` is tracked
   * automatically; `effect` covers what the plugin owns itself — timers,
   * watchers, sockets. Anything not routed through `ctx` cannot be tracked.
   */
  effect(dispose: () => void | Promise<void>): void;
}

// Structural minimum the host satisfies. NOT pino's Logger — a types-only package
// must not take a `pino` type dependency.
export interface PluginLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// ASYNC. getSettings() is Promise<OctomuxSettings> and dynamically imports
// harnesses/index.js. There is no sync full read.
export interface PluginSettingsScope {
  get<T = Record<string, unknown>>(): Promise<T>;
  update(patch: Record<string, unknown>): Promise<void>;
}

export interface PluginKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  del(key: string): void;
  list(prefix?: string): Array<{ key: string; value: unknown }>;
}

// All three qualify internally. The plugin declares a LOCAL id and never sees
// the qualified form.
export interface WorkflowRegistrar {
  register(wf: PluginWorkflow): void;
}
export interface IntegrationRegistrar {
  register(p: PluginIntegrationProvider): void;
}
export interface HarnessRegistrar {
  register(h: PluginHarness): void;
}

/**
 * `ctx.http` — route registration as DATA, not an Express Router.
 *
 * `WorkflowType.apiRouter` hands a plugin a Router, and express 5 cannot
 * unmount one; that single fact is why hot reload was a non-goal. Routes
 * registered here become rows in a lookup table behind one permanently-mounted
 * parent router, so removing a plugin deletes its rows and nothing was ever
 * mounted. Paths are namespaced under the manifest row id — a plugin declares
 * `/coverage/:task` and it serves at `/api/p/<pluginId>/coverage/:task`.
 */
export interface HttpRegistrar {
  route(method: HttpMethod, path: string, handler: PluginRouteHandler): void;
}
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Deliberately NOT express's `RequestHandler`: a types-only package must not
 * take an express type dependency, and the host owns the adapter. The shapes
 * are the subset the host guarantees.
 */
export type PluginRouteHandler = (req: PluginRequest, res: PluginResponse) => void | Promise<void>;
export interface PluginRequest {
  readonly params: Record<string, string>;
  readonly query: Record<string, unknown>;
  readonly body: unknown;
  /**
   * Lowercased header names, as express normalizes them. Without this a plugin
   * route cannot be authenticated at all — which is not a theoretical gap: the
   * first real migration off `apiRouter` (pr-extract's bearer-gated `/emit`)
   * was blocked on exactly this.
   */
  readonly headers: Record<string, string | string[] | undefined>;
}
export interface PluginResponse {
  status(code: number): PluginResponse;
  json(body: unknown): void;
}

/**
 * `ctx.facts` — a typed, task-scoped, append-only log every plugin can write
 * to and read from. The only wire between plugin types before this was
 * `HookEnvelope`: seven fixed event names, outbound only, fire-and-forget,
 * with no read path at all.
 *
 * Fact types are namespaced under the manifest row id, so a plugin can add
 * `coverage-bot:coverage` and can never overwrite `core:diff`. Facts are
 * task-scoped and die with the task. This is an observation log, not event
 * sourcing — tasks remain the source of truth.
 */
export interface FactsRegistrar {
  /** Declares a fact type and the JSON Schema that validates writes to it.
   *  The same schema tells the UI how to draw it (`ctx.ui`). */
  define(def: FactTypeDefinition): void;
  put(taskId: string, localType: string, payload: unknown): Promise<void>;
  read(taskId: string, opts?: FactQuery): Promise<Fact[]>;
  /** Subscribes to a QUALIFIED type (`core:diff`, `other-plugin:coverage`).
   *  Returns an unsubscribe; also auto-disposed on unmount. */
  watch(qualifiedType: string, onFact: (fact: Fact) => void): () => void;
}
export interface FactTypeDefinition {
  /** BARE local type. The host qualifies it to `<pluginId>:<type>`. */
  type: string;
  /** JSON Schema for the payload. */
  schema: Record<string, unknown>;
}
export interface FactQuery {
  /** Qualified fact type to filter on. */
  type?: string;
  /** Only facts with `seq` strictly greater than this. */
  sinceSeq?: number;
}
export interface Fact {
  seq: number;
  taskId: string;
  /** Qualified — `core:diff`, `coverage-bot:coverage`. */
  type: string;
  payload: unknown;
  createdAt: string;
}

/**
 * `ctx.ui` — declarative bindings, never components.
 *
 * There is no CSP anywhere and `server/remote-auth.ts` returns `allow`
 * unconditionally in local mode, so serving third-party ESM is not on the
 * table. A plugin contributes a binding and the client owns every renderer:
 * a plugin ships zero browser JavaScript and needs no build step.
 *
 * There is deliberately no `ctx.ui.component()` and no custom sidebar. That
 * ceiling keeps the security model intact and keeps plugins portable onto
 * surfaces that did not exist when they were written.
 */
export interface UiRegistrar {
  panel(binding: UiPanelBinding): void;
}
export type UiSlot =
  | 'task.panel'
  | 'task.badge'
  | 'board.card'
  | 'nav.section'
  | 'run.detail'
  | 'settings.card';
export type UiRenderer =
  | 'stat'
  | 'table'
  | 'timeline'
  | 'badge'
  | 'markdown'
  | 'json'
  | 'diff'
  | 'log';
export interface UiPanelBinding {
  slot: UiSlot;
  /** BARE local fact type — the host qualifies it, same as `facts.define`. */
  fact: string;
  /** Renderer name. An UNKNOWN renderer degrades to `json`, never a blank. */
  as: UiRenderer | string;
  /** Payload key holding the primary value (renderer-specific). */
  value?: string;
  /** Payload key holding a delta/secondary value (renderer-specific). */
  delta?: string;
  title?: string;
}

/**
 * `ctx.policy` — the one verb in the plugin API that can say **no**.
 *
 * Every other registrar is additive: a plugin contributes a workflow, a route,
 * a fact, a panel. None of them can stop something core was about to do.
 * `intercept` runs a hook between "a run wants to start" and "a run starts",
 * and that hook may deny with a reason or patch the intent on its way through.
 *
 * ## This is not a sandbox
 *
 * A plugin runs **in-process, with the DB handle, every credential, and
 * `process.env`**. It can call the same functions core calls without going
 * anywhere near `ctx.policy`. A capability grant does not stop it — grants are
 * a **coordination and audit mechanism**: they record what a plugin claims to
 * need, make that claim reviewable (`octomux doctor`), and give core one place
 * to log every decision against a task. Nothing here confines anything.
 * Out-of-process containment is a separate, unbuilt piece of work. Installing
 * a plugin is exactly as trusting as running its code yourself, because it is.
 *
 * ## Waterfall
 *
 * Hooks for a point run in registration order. The FIRST `deny` short-circuits
 * — later hooks do not run. A `patch` is merged into `intent.data` and the next
 * hook sees the patched values. A hook that throws or exceeds the host timeout
 * is logged and treated as "no opinion" (fail **open**): a crashing spend-cap
 * plugin must not wedge every launch in the install.
 *
 * ## Points
 *
 * | point              | `data` keys                                  | patchable |
 * | ------------------ | -------------------------------------------- | --------- |
 * | `task.launch`      | `harnessId`, `model`, `agent`                | `model`   |
 * | `harness.resume`   | `harnessId`, `model`, `prompt`               | `model`   |
 * | `review.publish`   | `verdict`, `bodyLength`                      | `verdict` |
 * | `integration.send` | `integrationKind`, `event`, `payload`        | `payload` |
 *
 * A key a call site does not list as patchable is ignored — the patch is a
 * request, and core decides what it honours.
 *
 * There is deliberately no `task.merge` point: core octomux never merges a PR
 * (`server/poller/merged-pr.ts` only *observes* merges that happened on
 * GitHub), so there is no call site to gate. Adding one would mean inventing
 * the merge path first.
 */
export interface PolicyRegistrar {
  /** Requires the `policy.intercept` capability grant in the manifest row.
   *  Without it this throws at registration and the plugin fails to load. */
  intercept(point: PolicyPoint, hook: PolicyHook): void;
}

export type PolicyPoint = 'task.launch' | 'harness.resume' | 'review.publish' | 'integration.send';

export interface PolicyIntent {
  readonly point: PolicyPoint;
  /** Present for task-scoped points. A decision on an intent without a
   *  `taskId` is logged but not recorded as a fact — facts are task-scoped. */
  readonly taskId?: string;
  readonly repoPath?: string;
  /** Point-specific fields (see the table above), with every earlier hook's
   *  patch already applied. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** `undefined` = no opinion, pass through. */
export type PolicyDecision =
  | void
  | { deny: string; patch?: never }
  | { patch: Record<string, unknown>; deny?: never };

export type PolicyHook = (intent: PolicyIntent) => PolicyDecision | Promise<PolicyDecision>;

/**
 * Capabilities a manifest row can grant. **Undeclared is denied** — a row with
 * no `grants` key grants nothing, and every registrar below throws for it.
 * That is deliberate: a warning that nobody reads is not a decision.
 *
 * Names are the `ctx` path of the method they gate, so the error message and
 * the manifest line read the same. Read-only members (`facts.read`,
 * `facts.watch`, `settings.get`, `logger`) are ungated.
 *
 * Again: this governs what a plugin can do *through `ctx`*. It is a statement
 * of intent that core can enforce at its own seams and show to a human — not
 * a privilege boundary around the plugin's code.
 */
export type PluginCapability =
  | 'workflows.register'
  | 'integrations.register'
  | 'harnesses.register'
  | 'http.route'
  | 'facts.define'
  | 'facts.put'
  | 'ui.panel'
  | 'policy.intercept';

// Registrar payload shapes are intentionally loose here — the plan leaves the
// concrete `WorkflowType` / `IntegrationProvider` / `Harness` bindings to the
// server-side registries (WAVE-2/WAVE-3), which are not browser- or
// plugin-facing. A types-only package must not import them.
export type PluginWorkflow = Record<string, unknown>;
export type PluginIntegrationProvider = Record<string, unknown>;
export type PluginHarness = Record<string, unknown>;

export interface PluginRow {
  id: string; // BARE local id, matches KIND_NAME_RE. Host qualifies.
  name: string; // npm package name OR absolute local path (dev loop)
  version?: string; // exact, not a range
  integrity?: string; // tarball hash; refuse to load on mismatch
  config?: Record<string, unknown>;
  disabled?: boolean;
  /**
   * Capabilities this plugin may use through `ctx`. Absent or empty means it
   * gets none — see `PluginCapability`. Widening this list on an existing row
   * does not take effect at the next boot: the added grants are withheld and
   * reported until `octomux plugins approve <id>` acknowledges them.
   */
  grants?: PluginCapability[];
}
export interface PluginManifest {
  plugins: PluginRow[];
}

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  resolvedPath: string;
  order: number;
  applyMs: number;
  reconcileMs?: number;
}
export interface LoadReport {
  loaded: LoadedPlugin[];
  failed: Array<{
    id: string;
    name: string;
    error: string;
    phase: 'resolve' | 'import' | 'apply' | 'reconcile';
  }>;
  manifestPath: string;
  safeMode: boolean;
  /** Set when the manifest itself failed to read/parse — distinguishes "zero
   *  plugins configured" from "boot couldn't even read the manifest". */
  manifestError?: string;
  /** ISO timestamp of when this report was produced, so a stale report from a
   *  boot that died doesn't read as current. Optional so existing/synthetic
   *  `LoadReport` literals (older persisted reports, fixtures) stay valid —
   *  `loadPlugins()` itself always sets it. */
  loadedAt?: string;
  /** Route count per plugin id, for `octomux doctor` (SHR-253). Written by
   *  `server/index.ts` after the loader runs, from `pluginRouteCounts()`.
   *  Optional for the same reason as `loadedAt`: a report persisted by an
   *  older build won't have it, and doctor omits the count rather than
   *  reporting zero. */
  routeCounts?: Record<string, number>;
  /** Effective capability grants per plugin id — what each plugin was actually
   *  allowed to use this boot. Printed by `octomux doctor`. Optional for the
   *  same reason as `loadedAt`: an older persisted report won't have it. */
  grants?: Record<string, PluginCapability[]>;
  /** Grants a row declares that have NOT been acknowledged yet, per plugin id.
   *  These were withheld this boot. Empty/absent when nothing is pending. */
  pendingGrants?: Record<string, PluginCapability[]>;
}

export const PLUGIN_API_VERSION = 0;

export interface OctomuxPlugin {
  apply(ctx: PluginContext): void | Promise<void>;
  /** REQUIRED for any plugin owning out-of-process state (worktrees, tmux, files
   *  written into a repo). Runs at boot after the DB is open. */
  reconcile?(ctx: PluginContext): Promise<void>;
}
