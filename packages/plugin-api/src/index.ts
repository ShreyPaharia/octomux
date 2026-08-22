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
  readonly workflows: WorkflowRegistrar;
  readonly integrations: IntegrationRegistrar;
  readonly harnesses: HarnessRegistrar;
  readonly compute: ComputeRegistrar;
  readonly http: HttpRegistrar;
  readonly records: RecordsRegistrar;
  /**
   * `ctx.services` — cross-plugin dependency by CAPABILITY rather than by
   * package name (SHR-260). A plugin provides `chat.send`; another requires
   * `chat.send`; neither names the other. Service names are the one thing in
   * this API that is NOT namespaced per plugin — a shared contract has to be
   * the same string on both sides. Requirements resolve after the whole
   * manifest has mounted, so a consumer may be listed before its provider.
   */
  readonly services: ServicesRegistrar;
  readonly artifacts: ArtifactsApi;
  readonly secrets: SecretsApi;
  readonly agents: AgentRunner;
  readonly ui: UiRegistrar;
  readonly policy: PolicyRegistrar;
  readonly surfaces: SurfaceRegistrar;
  /**
   * `ctx.attention` — ask a human a question and await the answer. Not a
   * registrar: nobody needs a different way to reach a human, they need to
   * reach one. See `AttentionApi`.
   */
  readonly attention: AttentionApi;
  /**
   * `ctx.fanout` — run a step per item instead of once per schedule fire.
   * See `FanOutApi`. Not a registrar: nobody needs a different fan-out
   * implementation, they need to run one.
   */
  readonly fanout: FanOutApi;
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
   *  `route:GET /coverage/:task`, `ui:task.panel`, `fact:demo:coverage`,
   *  `collection:demo:baselines`. */
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

/**
 * `ctx.kv` — plugin-PRIVATE durable scratch: opaque blobs keyed by a string,
 * scoped to the plugin that wrote them. Nobody but the owning plugin can
 * read a kv entry.
 *
 * NOT `ctx.collections`: a collection is schema-validated, keyed on a field
 * the plugin nominates, and readable by any plugin (`query` takes a bare OR
 * qualified name — reads are unscoped by design). kv has no schema, no query
 * language beyond a key or a key prefix, and only its own plugin can ever
 * see it.
 *
 * NOT `ctx.facts`: facts are an append-only log scoped to one task and die
 * with it. kv has no task in the picture at all — it is the plugin's own
 * durable memory, independent of any run.
 *
 * kv state deliberately OUTLIVES an unmount. Every registrar on `ctx` (a
 * workflow, a route, a fact type, a UI panel) is undone when the plugin
 * unmounts — that's the whole point of the registrar model. kv is the one
 * exception: nothing here is deregistered on teardown, because a
 * hot-reloaded or restarted plugin must find its checkpoints, and its
 * ordinary state, still sitting there when `apply()` runs again. That
 * asymmetry is deliberate, not an oversight.
 *
 * `begin`/`end`/`interrupted` are the crash-recovery half of this API. They
 * share `get`/`set`'s key space (prefix your keys to avoid collisions) but
 * stamp a mark identifying which plugin *mount* wrote them. A checkpoint
 * left in place by a mount other than the current one is, by construction,
 * an operation that never finished — the process crashed mid-`begin`, or a
 * hot reload tore that mount down before it called `end`. `apply()` is the
 * natural place to call `interrupted()` and decide what to do about it —
 * this is the plugin-side analogue of `recoverTasks()` at host boot, and it
 * adds no new boot pass of its own.
 */
export interface PluginKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  del(key: string): void;
  list(prefix?: string): Array<{ key: string; value: unknown }>;
  /** Marks an operation in flight, checkpointing whatever this plugin needs to
   *  resume it. Same key space as `set`/`get` — prefix your keys. */
  begin(key: string, value: unknown): void;
  /** The operation finished. Deletes the checkpoint. */
  end(key: string): void;
  /** Checkpoints left behind by a previous mount — a crash, or a hot reload
   *  that tore the plugin down mid-operation. Empty on a clean start. */
  interrupted(): Array<{ key: string; value: unknown; startedAt: string }>;
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
 * Registers a compute provider — where a task's git worktree lives and where
 * its processes run. NOT a pluggable isolation strategy: a git worktree per
 * run is octomux's guarantee, not a preference. This decides *where that
 * worktree lives*, nothing more.
 */
export interface ComputeRegistrar {
  register(p: PluginCompute): void;
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
 * `ctx.collections` — durable, keyed records that OUTLIVE a task (SHR-275).
 *
 * `ctx.facts` is an append-only log scoped to one task; when the task is
 * deleted its facts go with it. That makes it the wrong home for anything a
 * plugin wants to keep — a per-repo score, a rolling index, a registry of
 * things it has seen. A collection is the other half: a small set of records
 * keyed by a field the plugin nominates, upserted on write, with no task in
 * the picture at all.
 *
 * It is deliberately NOT `plugin_facts` with a nullable `task_id`. Same
 * reasoning as ruling R1 in `plans/2026-08-20-plugin-runtime-p0.md`: two
 * concerns with different lifetimes (one dies with a task, one does not) do
 * not share one table, one AUTOINCREMENT sequence, and one drain.
 *
 * Names are namespaced under the manifest row id exactly like fact types, so
 * a plugin can add `coverage-bot:baselines` and can never overwrite a
 * `core:` name.
 *
 * NOT `ctx.kv` (SHR-263). kv is opaque per-plugin blobs keyed by a string;
 * this is schema-validated, queryable records. They may end up sharing a
 * storage layer; they are not the same API.
 */
export interface CollectionsRegistrar {
  /** Declares a collection, its record schema, and which record field is the
   *  upsert key. `def.name` is BARE — the host qualifies it. */
  define(def: CollectionDefinition): void;
  /** Upserts one record on its `key` field. `collection` is the plugin's own
   *  BARE local name — a plugin writes only its own collections, so a
   *  qualified name here is an error, not a cross-plugin write. */
  put(collection: string, record: unknown): Promise<void>;
  /** Reads records. `collection` may be BARE (this plugin's own) or QUALIFIED
   *  (`other-plugin:baselines`) — reads are unscoped, same as `facts.read`. */
  query(collection: string, q?: QuerySpec): Promise<unknown[]>;
  /** Subscribes to a QUALIFIED name. In-process, fired on write. Returns an
   *  unsubscribe; also auto-disposed on unmount. */
  watch(qualifiedName: string, cb: (record: unknown) => void): () => void;
}

export interface CollectionDefinition {
  /** BARE local name. The host qualifies it to `<pluginId>:<name>`. */
  name: string;
  /** JSON Schema every record is validated against on write. */
  schema: Record<string, unknown>;
  /** Top-level record property holding the record's identity. Writes upsert
   *  on it, so `put` twice with the same key value replaces, never appends. */
  key: string;
}

/**
 * Deliberately small. Exact-match filters, an order and a window — enough for
 * a panel binding and a plugin's own bookkeeping. There is no operator
 * language, no join, and no aggregate: a plugin that needs those has outgrown
 * this API rather than found a gap in it.
 */
export interface QuerySpec {
  /** Exact-match on top-level record fields, AND-ed together. */
  where?: Record<string, unknown>;
  /** Top-level record field to sort by. Default: `updatedAt`. */
  orderBy?: string;
  /** Default `asc`. */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** One stored record, as the REST surface and the repository return it. The
 *  registrar's `query()` hands back the bare `record` values instead. */
export interface CollectionRecord {
  /** Qualified — `coverage-bot:baselines`. */
  collection: string;
  /** The stringified value of the record's `key` field. */
  key: string;
  record: unknown;
  /** `YYYY-MM-DD HH:MM:SS` UTC — sqlite `datetime('now')` shape. */
  createdAt: string;
  updatedAt: string;
}

/**
 * `ctx.records` — the single store behind what used to be `ctx.facts`,
 * `ctx.collections` and `ctx.kv` (SHR-282). One definition shape covers all
 * three prior lifetimes: `scope` picks task-scoped vs durable (facts vs
 * collections/kv), `mode` picks append-only vs upsert-on-key (facts vs
 * collections), and an opaque store with no `schema` recovers `ctx.kv`.
 */
export interface RecordStoreDefinition {
  /** BARE local name — the host qualifies it to `<pluginId>:<name>`. */
  name: string;
  /** JSON Schema validated on write. Omit for an opaque store (the old ctx.kv). */
  schema?: Record<string, unknown>;
  /** Record field used as identity. Required when `mode` is 'upsert'. */
  key?: string;
  /** 'task' rows die with their task; 'durable' rows outlive unmount. */
  scope: 'task' | 'durable';
  /** 'append' adds a row; 'upsert' replaces the row with the same key. */
  mode: 'append' | 'upsert';
}

/** What `read`, `query` and `watch` hand back. Uniform across every scope and
 *  mode: the pre-collapse ctx.facts fired a full envelope while ctx.collections
 *  fired a bare record, and one shape is strictly more information. */
export interface RecordEnvelope {
  seq: number;
  store: string;
  taskId: string | null;
  key: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RecordsRegistrar {
  define(def: RecordStoreDefinition): void;
  put(name: string, record: unknown, opts?: { taskId?: string }): Promise<void>;
  read(name: string, opts?: { taskId: string }): Promise<RecordEnvelope[]>;
  query(name: string, q?: QuerySpec): Promise<RecordEnvelope[]>;
  watch(qualifiedName: string, onRecord: (rec: RecordEnvelope) => void): () => void;
  /** Checkpoints (from the pre-collapse ctx.kv). `name` is required: one plugin
   *  can own several stores, and a per-plugin checkpoint key would let two of
   *  them collide — a failure the flat plugin_kv namespace could not have. */
  begin(name: string, key: string, value: unknown): void;
  end(name: string, key: string): void;
  /** Checkpoints left by some OTHER mount — by construction, work that never
   *  finished. Omit `name` for every store this plugin owns. */
  interrupted(name?: string): RecordEnvelope[];
}

/**
 * `ctx.artifacts` — files a run produced: a review report, a coverage summary,
 * a generated diagram. Written into the task's worktree under
 * `.octomux/artifacts/<pluginId>/<name>`, alongside the narrative
 * `.octomux/artifact.md`.
 *
 * Deliberately a METHOD ON ctx, not a registrar. Nobody needs a different
 * artifact implementation; they need to write one. There is no
 * `artifacts.register()` and there will not be.
 */
export interface ArtifactsApi {
  /** Writes (or overwrites) one artifact for a task. Rejects if the task has
   *  no worktree yet. */
  write(taskId: string, artifact: ArtifactInput): Promise<ArtifactEntry>;
  /** Every artifact on the task, from EVERY plugin — same unscoped read as
   *  `facts.read`. Empty when the task has no worktree. */
  list(taskId: string): Promise<ArtifactEntry[]>;
}
export interface ArtifactInput {
  /** Bare filename. `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, no separators, no `..`. */
  name: string;
  /** e.g. `text/markdown`, `application/json`, `image/svg+xml`. */
  mime: string;
  body: string;
}
export interface ArtifactEntry {
  /** Manifest row id of the writing plugin — artifacts are namespaced by it,
   *  so two plugins can both write `report.md`. */
  pluginId: string;
  name: string;
  mime: string;
  /** utf8 byte length of the body. */
  size: number;
  /** `YYYY-MM-DD HH:MM:SS` UTC — same shape as sqlite `datetime('now')`. */
  updatedAt: string;
  /** Path serving the content: `/api/tasks/<taskId>/artifacts/<pluginId>/<name>`. */
  url: string;
}

/**
 * `ctx.secrets` — reference-by-name credentials (SHR-277).
 *
 * `list()` returns NAMES ONLY and is ungated, matching `facts.read` /
 * `catalog.list`: knowing a credential exists is not the thing worth a second
 * look. `resolve()` returns VALUES and is gated on `secrets.read` — a plugin
 * that can enumerate every credential on the box by default would make the
 * grants system decorative.
 *
 * There is no write path. A secret is written by a human (UI/CLI/API), never by
 * a plugin.
 */
export interface SecretsApi {
  list(): Promise<string[]>;
  /** Substitutes `${secret:NAME}` in every string leaf of `value`. Requires
   *  `secrets.read`. Call it at egress — never store or log the result. */
  resolve<T>(value: T): Promise<T>;
}

export interface AgentRunOptions {
  /** The prompt / task description handed to the agent. */
  input: string;
  /** JSON Schema the agent's structured result must conform to. */
  outputSchema: object;
  model?: string | null;
  timeoutMs?: number;
  /** Defaults to a fresh ephemeral scratch dir. No git, no worktree. */
  workspaceDir?: string;
}

/**
 * `ctx.agents` — run a headless, structured-output agent session: hand it a
 * prompt and a JSON Schema, get back a validated result. Same primitive core
 * uses for schedule verticals (`runAgentSession`), stripped of the schedule
 * bookkeeping.
 *
 * Deliberately a METHOD ON ctx, not a registrar — same reasoning as
 * `ctx.artifacts`: nobody needs a different agent-runner implementation,
 * they need to run one.
 *
 * This is NOT the task lifecycle. It never creates a git worktree, a branch,
 * or a tmux session — that machinery is for agents that write code back into
 * a repo. An agent run here reads its input, searches, and returns JSON. The
 * default workspace is a fresh, empty, throwaway scratch directory: no
 * CLAUDE.md, no repo, no project skills bleeding into the prompt — a clean
 * room, not a shortcut.
 *
 * There is no concurrency cap here. A plugin that fans out N runs owns its
 * own limiter; this is a single call, not a queue.
 *
 * pty only. The session is not reattachable and does not survive a host
 * restart — it lives and dies within one `run()` call.
 */
export interface AgentRunner {
  run<T = unknown>(opts: AgentRunOptions): Promise<T>;
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
  /**
   * Declares an ACTION — a named handler the HOST invokes (SHR-257).
   *
   * The read half of `ctx.ui` draws data; this is the write half. It changes
   * nothing about the ceiling: `def.run` stays in the host process and is
   * addressed over REST by its qualified id. What reaches the browser is the
   * declaration MINUS the handler — a label, a slot, an optional JSON Schema.
   * Still zero plugin JavaScript in the client, still portable onto a surface
   * that did not exist when the action was written.
   *
   * Requires the `ui.action` capability grant.
   */
  action(def: UiActionDefinition): void;
}

/**
 * One `ctx.ui.action()` declaration.
 *
 * `run` is the ONLY function here and it never leaves the host. Everything
 * else is data the client can render on its own: a label to put on a button,
 * a slot to put the button in, a JSON Schema to build a form from, a confirm
 * string to gate it behind.
 */
export interface UiActionDefinition {
  /** BARE local id — the host qualifies it to `<pluginId>:<id>`. */
  id: string;
  /** Button / command-entry text. */
  label: string;
  /** Where the trigger renders. Omit for a command-palette-only action. */
  slot?: UiSlot;
  /**
   * JSON Schema for the action's input. Present → the client renders a form
   * from it (the same schema-driven form the schedules UI uses) and the host
   * validates the submitted values against it before `run` sees them. Absent
   * → the action takes no input and `invocation.input` is `{}`.
   */
  schema?: Record<string, unknown>;
  /** Surfaces this action in whatever command palette the surface has. */
  command?: boolean;
  /** Shown as a confirmation before running. Absent → runs immediately. */
  confirm?: string;
  /**
   * Runs IN THE HOST when the action is invoked. Throwing surfaces the message
   * to the caller; there is no timeout, the transport bounds the wait.
   */
  run(invocation: UiActionInvocation): Promise<UiActionResult | void> | UiActionResult | void;
}

export interface UiActionInvocation {
  /** Present when invoked from a task-scoped slot. */
  taskId?: string;
  /** Schema-validated when the action declared a `schema`; `{}` otherwise. */
  input: Record<string, unknown>;
}

/** What `run` may hand back to the caller. `void` is fine — most actions just do
 *  the thing. */
export interface UiActionResult {
  /** Shown to the human who triggered the action. */
  message?: string;
}

/** An action as served to a client: the declaration with its handler stripped
 *  and its id qualified. What `GET /api/plugin-ui/actions` returns. */
export interface UiActionContribution {
  /** Manifest row id of the contributing plugin. */
  pluginId: string;
  /** Qualified — `<pluginId>:<id>`. The address `POST /api/plugin-ui/actions/:id` takes. */
  actionId: string;
  /** Bare local id as the plugin declared it. */
  id: string;
  label: string;
  slot?: UiSlot;
  schema?: Record<string, unknown>;
  command?: boolean;
  confirm?: string;
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
/** A panel bound to a `ctx.records` store (SHR-282) — task-scoped or durable,
 *  the slot renders whatever the store's rows are. Replaces the pre-collapse
 *  `UiFactPanelBinding | UiCollectionPanelBinding` union: one store shape
 *  covers both prior lifetimes, so one binding shape does too. */
export interface UiPanelBinding {
  slot: UiSlot;
  /** BARE local store name — the host qualifies it. */
  record: string;
  as: UiRenderer | string;
  value?: string;
  delta?: string;
  title?: string;
}

/**
 * `ctx.surfaces` — where octomux presents itself to a human.
 *
 * octomux already speaks web (and the macOS/phone shells around it), CLI,
 * Slack and Telegram. Every one of those was compiled in: adding a fifth meant
 * editing core. This registrar is the seam that ends that — a plugin adds a
 * surface and every `ctx.ui` panel that already exists appears on it.
 *
 * That works only because `ctx.ui` panels are declarative BINDINGS, not
 * components (see `UiRegistrar`). A binding names a fact type (or, since
 * SHR-279, a collection) and a renderer; it never names a DOM, a Block Kit
 * block or an ANSI escape. So a panel written a year before Discord existed
 * as a surface still renders on Discord, with no change to the plugin that
 * wrote it. This is the entire reason the binding model was chosen, and
 * there is a test that holds it to it. A collection-bound binding renders
 * the same way: its records reach `render` adapted into `SurfacePanel.facts`
 * (see that type's doc), so `render` itself never branches on which kind of
 * binding it is drawing.
 *
 * ## The renderer contract
 *
 * A surface declares the renderer names it can draw (`renderers`). The host
 * resolves every panel against that list BEFORE calling `render`:
 *
 * - `panel.as`       — what the binding asked for.
 * - `panel.renderer` — what this surface will actually draw. Equal to
 *                      `panel.as` when the surface supports it, otherwise the
 *                      surface's `fallback` (default `'json'`).
 *
 * `panel.renderer` is GUARANTEED to be in `renderers` (or the fallback), so a
 * `render` implementation only ever handles the list it declared. A surface
 * that declares `['markdown']` receives `renderer: 'markdown'` for a `stat`
 * panel — degraded, never dropped, never blank. Same rule the web client has
 * always applied to an unknown renderer name.
 *
 * ## Read-only surfaces
 *
 * `prompt` is optional. A surface without one is **read-only**: it draws
 * panels and cannot ask a question. Asking a read-only surface throws with a
 * message naming the surface — it is not silently swallowed, because a
 * question nobody can answer is a wedged run, not a degraded one.
 *
 * ## Rendering in-process vs. delegating to a client
 *
 * `render` returns the text this surface's transport takes (mrkdwn for Slack,
 * plain text for CLI/Telegram, whatever a plugin surface wants). Core's `web`
 * surface is the one exception and omits `render` entirely: the browser owns
 * every renderer and reads the binding table over REST. A PLUGIN surface must
 * provide `render` — the registrar rejects one that doesn't, since there is no
 * client of yours for core to delegate to.
 *
 * Surface kinds are qualified like every other registrar: a plugin declares
 * `discord` and the host serves it as `<pluginId>:discord`. Core's four
 * (`web`, `cli`, `slack`, `telegram`) are frozen before any plugin loads and
 * cannot be redefined.
 */
export interface SurfaceRegistrar {
  /** Requires the `surfaces.register` capability grant in the manifest row. */
  register(surface: SurfaceDefinition): void;
}

/** One `ctx.ui` panel binding, resolved for one surface and loaded with the
 *  facts it renders. What `SurfaceDefinition.render` receives.
 *
 *  Exactly one of `factType` / `collectionName` is set, mirroring
 *  `UiPanelBinding` (SHR-279). `facts` is populated either way: a
 *  collection-bound panel's records arrive here adapted into the same
 *  `Fact` shape (see `renderCollectionPanels` in `server/surfaces/render.ts`),
 *  so `render` never has to know which kind of binding it is drawing — a
 *  `render` written before collections existed still draws a collection
 *  panel with zero change. */
export interface SurfacePanel {
  /** Manifest row id of the plugin that declared the binding. */
  pluginId: string;
  slot: UiSlot;
  /** Qualified fact type — `<pluginId>:<fact>`. Present iff this is a
   *  fact-bound panel. */
  factType?: string;
  /** Qualified collection name — `<pluginId>:<collection>`. Present iff
   *  this is a collection-bound panel (SHR-279). */
  collectionName?: string;
  /** Renderer the binding asked for. */
  as: string;
  /** Renderer this surface will draw — `as`, or the surface's fallback. */
  renderer: string;
  value?: string;
  delta?: string;
  title?: string;
  /** Facts for this binding on the task being rendered, oldest first — or,
   *  for a collection-bound panel, its records adapted into the same shape.
   *  See the type doc above. */
  facts: Fact[];
}

/** A question put to a human on a surface. */
export interface SurfacePrompt {
  /** Present when the question is about a specific task. */
  taskId?: string;
  question: string;
  /** Offered answers. Absent means free text. */
  choices?: string[];
  /**
   * Aborted when the question no longer needs an answer — another surface
   * answered first, the ask timed out, or the asking plugin unmounted. A
   * `prompt` that posted a message, opened a modal or started a poll should
   * honour this and WITHDRAW it; the host ignores whatever a withdrawn
   * prompt resolves to either way. Absent when the caller has no way to
   * withdraw (a direct `promptOn()`).
   */
  signal?: AbortSignal;
}

/**
 * `ctx.attention` — the one verb that makes a plugin STOP and ask a person.
 *
 * `ctx.surfaces` gave octomux a way to reach a human on more than the four
 * places it compiles in. This is what a plugin calls to use that: one
 * question, fanned out to EVERY registered surface that declares `prompt`,
 * resolved by whichever human answers first.
 *
 * ```ts
 * const { status, answer } = await ctx.attention.ask({
 *   taskId,
 *   question: 'Ship this to prod?',
 *   choices: ['ship', 'hold'],
 *   defaultAnswer: 'hold',
 * });
 * ```
 *
 * ## First answer wins, the rest are withdrawn
 *
 * The losing surfaces get their `SurfacePrompt.signal` aborted, so a Slack
 * message can be deleted and a Discord modal closed rather than left sitting
 * there collecting an answer nobody will read. A surface that ignores the
 * signal is not broken — its late answer is simply discarded.
 *
 * ## Bounded, always
 *
 * `timeoutMs` (default 5 minutes — `DEFAULT_ATTENTION_TIMEOUT_MS` in
 * `server/attention/index.ts`; this package stays types-only) bounds the
 * wait. On timeout — and when there is no prompt-capable surface to ask at
 * all — the call RESOLVES with `defaultAnswer`, it does not reject and it
 * does not hang. Read `status` before you act on `answer`: `'answered'` is a
 * human, anything else is your own default coming back to you.
 *
 * ## It does not survive a restart
 *
 * Stated plainly because the alternative is a plugin trusting it: a pending
 * ask lives in memory only. A surface's `prompt` is a live in-process
 * function and the `await` on the other side is a live promise — both die
 * with the process, so there is nothing a DB row could resume. Restart the
 * server mid-ask and the question is gone; nothing is re-asked and nothing
 * is answered. Don't build an approval gate that must not be lost on top of
 * it (core's `server/orchestrator/gate.ts` is the DB-backed one).
 */
export interface AttentionApi {
  /** Requires the `attention.ask` capability grant. Never rejects on a
   *  timeout or an unreachable human — see `AttentionAnswer.status`. */
  ask(ask: AttentionAsk): Promise<AttentionAnswer>;
}

export interface AttentionAsk {
  /** Present when the question is about a specific task. Passed through to
   *  every surface as `SurfacePrompt.taskId`. */
  taskId?: string;
  question: string;
  /** Offered answers. Absent means free text. */
  choices?: string[];
  /** How long to wait before giving up and returning `defaultAnswer`.
   *  Default 5 minutes. */
  timeoutMs?: number;
  /** What `answer` holds when no human answers — on timeout, when every
   *  surface declines, and when no registered surface can prompt at all.
   *  Undefined by default, which is a perfectly good "no decision". */
  defaultAnswer?: string;
}

export interface AttentionAnswer {
  /**
   * - `answered`     — a human answered on `surface`.
   * - `timeout`      — nobody answered within `timeoutMs`.
   * - `unanswerable` — nobody could be asked: no registered surface declares
   *                    `prompt`, or every one of them declined or threw.
   */
  status: 'answered' | 'timeout' | 'unanswerable';
  /** The human's answer when `status === 'answered'`, otherwise
   *  `AttentionAsk.defaultAnswer` (so `undefined` unless you set one). */
  answer?: string;
  /** Qualified kind of the surface that answered. Only set for `'answered'`. */
  surface?: string;
}

export interface SurfaceDefinition {
  /** BARE local kind — the host qualifies it to `<pluginId>:<kind>`. */
  kind: string;
  /** Renderer names this surface draws natively. Anything else falls back. */
  renderers: Array<UiRenderer | string>;
  /** Renderer used for a panel this surface can't draw. Defaults to `'json'`.
   *  Must itself be something `render` handles. */
  fallback?: string;
  /** Renders one panel into this surface's transport. `undefined` means
   *  "nothing to show" and the panel is omitted, not rendered blank.
   *  REQUIRED for plugin surfaces; omitted only by core's `web`. */
  render?(panel: SurfacePanel): string | undefined;
  /** Absent → the surface is read-only. */
  prompt?(ask: SurfacePrompt): Promise<string | undefined>;
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
 * `ctx.fanout` — run a step **per item**, not per schedule fire.
 *
 * One cron fire is one session and one output blob. A pipeline is "do this to
 * each of N things". Without this the only declarative way to process 60
 * records is to stuff all 60 into one prompt and parse one blob back, which
 * loses per-item status, per-item retry, progress, and eventually the context
 * window.
 *
 * `run()` maps `each` over an item source — a plain array, a collection query
 * (`ctx.collections`), or a previous run being redriven — and gives you:
 *
 * - **per-item status**, persisted, so a partial run is legible and resumable
 * - **a concurrency cap the host enforces**, shared across every plugin
 * - **retry with bounded exponential backoff**
 * - **a dead-letter state** for items that exhaust their attempts, plus a
 *   redrive path (`{ resume: runId }`)
 *
 * ## The cap lives here, deliberately
 *
 * `ctx.agents.run()` is a thin accessor onto the harness session runner; it
 * carries no scheduling policy. Fan-out is where scheduling policy belongs,
 * because fan-out is the runaway case: a plugin looping 500 records through a
 * subscription-backed harness saturates the operator's rate limits with no
 * backpressure and no signal. The host cap is global — every plugin's fan-out
 * runs draw from ONE budget, so N plugins asking for 8 each do not add up to
 * 8N concurrent sessions. A per-run `concurrency` is a request, clamped down
 * to the host's ceiling and never up.
 *
 * ## What it is not
 *
 * Not a DAG. There is no step composition and no chaining of one step's output
 * into the next: chain by writing to a collection and querying it from the
 * next step. Not distributed either — every item runs in this process.
 */
export interface FanOutApi {
  /** Requires the `fanout.run` capability grant. Resolves when every item has
   *  reached a terminal state (`done` or `dead`), or the run was aborted —
   *  item failures come back in the summary rather than as a rejection.
   *  Rejects only when the run could not start (bad spec, unresolvable
   *  source). */
  run<T = unknown, R = unknown>(spec: FanOutSpec<T, R>): Promise<FanOutRunSummary>;
  /** One run with its per-item rows. Ungated read, matching `facts.read`. */
  status(runId: string): Promise<FanOutRunStatus | undefined>;
  /** This plugin's fan-out runs, newest first. Ungated read. */
  list(name?: string): Promise<FanOutRunSummary[]>;
}

/**
 * Where the items come from. Deliberately an interface rather than an array
 * parameter so a collection query and a literal array are the same call:
 *
 * - `{ items }`      — a plain array, e.g. the previous step's output
 * - `{ collection }` — a `ctx.collections` query, resolved by the host
 * - `{ resume }`     — the redrive path: items come from the stored run,
 *                      already-`done` ones are skipped, dead-lettered ones get
 *                      a fresh attempt budget
 */
export type FanOutSource<T = unknown> =
  | { items: readonly T[] }
  | { collection: string; query?: Record<string, unknown> }
  | { resume: string };

export interface FanOutSpec<T = unknown, R = unknown> {
  /** BARE local name. The host qualifies it to `<pluginId>:<name>`, same as
   *  `facts.define`. Groups runs of the same step together for `list()`. */
  name: string;
  source: FanOutSource<T>;
  /** Runs once per item, at most `concurrency` at a time. Throwing schedules a
   *  retry; exhausting `maxAttempts` dead-letters the item and leaves the rest
   *  of the run alone. */
  each: (item: T, meta: FanOutItemMeta) => Promise<R>;
  /** Item identity — what per-item status is keyed on, and what makes a
   *  redrive skip work already done. Defaults to a stable hash of the item, so
   *  two identical items collapse into one row; supply this when the item has
   *  a real id. */
  key?: (item: T) => string;
  /** Requested parallelism. Clamped to the host ceiling — never raises it. */
  concurrency?: number;
  /** Attempts per item before it is dead-lettered. Default 3, minimum 1. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between attempts, in ms. Default 1000
   *  (so 1s, 2s, 4s …). */
  backoffMs?: number;
}

export interface FanOutItemMeta {
  runId: string;
  /** This item's identity key — see `FanOutSpec.key`. */
  key: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Aborted when the plugin unmounts. A handler that runs anything long —
   *  an agent session, an HTTP call — should honour it; the host stops
   *  scheduling new items either way. */
  signal: AbortSignal;
}

export type FanOutRunState = 'running' | 'done' | 'failed' | 'canceled';
export type FanOutItemState = 'pending' | 'running' | 'done' | 'dead';

export interface FanOutRunSummary {
  runId: string;
  /** Qualified — `<pluginId>:<name>`. */
  name: string;
  /** `failed` means the run finished with at least one dead-lettered item, not
   *  that the run itself crashed. */
  status: FanOutRunState;
  total: number;
  succeeded: number;
  /** Dead-lettered — exhausted `maxAttempts`. Redrive with `{ resume: runId }`. */
  dead: number;
  /** Neither done nor dead yet: nonzero only on a `running` or `canceled` run. */
  pending: number;
  createdAt: string;
  updatedAt: string;
}

export interface FanOutRunStatus extends FanOutRunSummary {
  items: FanOutItemStatus[];
}

export interface FanOutItemStatus {
  key: string;
  status: FanOutItemState;
  attempts: number;
  /** The item itself, as handed to `run()` — kept so a redrive can replay it
   *  after a restart, when the source array is long gone. */
  item: unknown;
  /** Whatever `each` resolved with, when it succeeded. */
  result?: unknown;
  /** Last error message, on a retrying or dead-lettered item. */
  error?: string;
  updatedAt: string;
}

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
 *
 * `collections.query` / `collections.watch` are ungated for the same reason
 * `facts.read` / `artifacts.list` are: reading what is installed or recorded
 * is not the thing worth a second look.
 *
 * `secrets.list()` (names only) is ungated for the same reason — knowing a
 * credential exists is not the thing worth a second look. `secrets.resolve()`
 * returns values, so it IS gated on `secrets.read`.
 *
 * `services.require()` is ungated too: declaring a dependency is a statement
 * about this plugin, not a reach into anyone else's. `services.provide()` puts
 * an implementation into a namespace every other plugin reads, so it IS gated.
 */
/**
 * `ctx.services` — the seam that lets one plugin depend on "something that can
 * send chat messages" instead of on `octomux-plugin-slack`.
 *
 * **Names are unqualified and shared.** Everything else a plugin registers is
 * prefixed with its manifest id; a service name is not, because `chat.send`
 * must be the same string coming from the provider and the consumer.
 *
 * **First provider wins.** If two plugins provide the same name, the one that
 * appears earlier in `octomux.yml` is live; the other queues behind it and
 * takes over if the first unmounts. Reordering the two rows is how you choose.
 *
 * **Unmet requirements fail the plugin, not the boot.** `require()` records the
 * dependency; the host checks it once every row has been applied, so ordering
 * does not matter. An unmet name lands in the load report as a `phase: 'apply'`
 * failure naming the plugin and the service — the same shape an ungranted
 * capability produces.
 */
export interface ServicesRegistrar {
  /** Publishes an implementation under a shared name. Requires the
   *  `services.provide` capability. Throws if this plugin already provides it. */
  provide(name: string, impl: unknown): void;
  /** Declares a dependency and returns a live handle to it. Safe to call during
   *  `apply()` before the provider has mounted — nothing is resolved until
   *  `handle.get()`. */
  require<T = unknown>(name: string): ServiceHandle<T>;
}

export interface ServiceHandle<T = unknown> {
  /** The service name this handle was created for. */
  readonly name: string;
  /** The live implementation. Throws if nothing provides the name — which the
   *  mount-time check makes unreachable unless the provider unmounted since. */
  get(): T;
}

export type PluginCapability =
  | 'workflows.register'
  | 'integrations.register'
  | 'harnesses.register'
  | 'compute.register'
  | 'http.route'
  | 'records.define'
  | 'records.write'
  | 'services.provide'
  | 'ui.panel'
  | 'ui.action'
  | 'artifacts.write'
  | 'policy.intercept'
  | 'agents.run'
  | 'fanout.run'
  | 'surfaces.register'
  | 'attention.ask'
  | 'secrets.read';

// Registrar payload shapes are intentionally loose here — the plan leaves the
// concrete `WorkflowType` / `IntegrationProvider` / `Harness` bindings to the
// server-side registries (WAVE-2/WAVE-3), which are not browser- or
// plugin-facing. A types-only package must not import them.
export type PluginWorkflow = Record<string, unknown>;
export type PluginIntegrationProvider = Record<string, unknown>;
export type PluginHarness = Record<string, unknown>;
export type PluginCompute = Record<string, unknown>;

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
