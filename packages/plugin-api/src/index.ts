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
  /**
   * `ctx.catalog` — a READ over what is currently installed (SHR-268): this
   * plugin's own registrations plus every sibling's and core's, as one flat
   * list. There is deliberately no write path and no override path here —
   * reading what is installed is a query, not an implementation choice, so
   * this is NOT a registrar and has no `register()`. Backed by the same live
   * registries every other `ctx.*` surface writes into.
   */
  readonly catalog: CatalogReader;
  /**
   * Registers a teardown callback run when this plugin unmounts, in reverse
   * registration order. Everything registered *through* `ctx` is tracked
   * automatically; `effect` covers what the plugin owns itself — timers,
   * watchers, sockets. Anything not routed through `ctx` cannot be tracked.
   */
  effect(dispose: () => void | Promise<void>): void;
}

/**
 * One installed unit — a plugin or core itself — as `ctx.catalog` reports it.
 */
export interface CatalogEntry {
  /** Bare plugin id, or the literal `'core'`. */
  id: string;
  kind: 'plugin' | 'core';
  /** Everything this unit contributes, as `<registry>:<qualified id>` strings —
   *  `workflow:demo:changelog`, `harness:demo:foo`, `integration:jira`,
   *  `route:GET /coverage/:task`, `ui:task.panel`, `fact:demo:coverage`. */
  provides: string[];
  /** `name@version` for a plugin (resolved path when a local-path row has no
   *  version), `'built-in'` for core. */
  source: string;
}

export interface CatalogReader {
  list(): CatalogEntry[];
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
  /** Everything this plugin contributed, `<registry>:<qualified id>` form —
   *  same shape as `CatalogEntry.provides`, for `octomux doctor`'s no-server
   *  `buildCatalog()` (SHR-268). Optional for the same reason as `loadedAt`:
   *  an older persisted report won't have it. */
  provides?: string[];
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
}

export const PLUGIN_API_VERSION = 0;

export interface OctomuxPlugin {
  apply(ctx: PluginContext): void | Promise<void>;
  /** REQUIRED for any plugin owning out-of-process state (worktrees, tmux, files
   *  written into a repo). Runs at boot after the DB is open. */
  reconcile?(ctx: PluginContext): Promise<void>;
}
