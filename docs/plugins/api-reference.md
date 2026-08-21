# API reference

Every type here is pinned in `packages/plugin-api/src/index.ts` — that
package is **types only** (CI asserts its build output is `export {};`, see
the file's own header comment). Nothing at runtime crosses that boundary;
what your plugin actually gets is built by `server/plugins/context.ts` and
enforces the rules below. Where a registrar payload is typed loosely
(`Record<string, unknown>`) in `@octomux/plugin-api`, the concrete
server-side type is listed too, since that's what your object needs to
satisfy in practice.

## `OctomuxPlugin`

```ts
export interface OctomuxPlugin {
  apply(ctx: PluginContext): void | Promise<void>;
  reconcile?(ctx: PluginContext): Promise<void>;
}
```

- `apply` — required. Called once per boot, per enabled manifest row.
  Export it named (`export function apply(ctx) {}`) or on a default export
  (`export default { apply }`) — the loader accepts either
  (`server/plugins/loader.ts::pluginApply`).
- `reconcile` — **on the interface, not called by anything today.** Intended
  for a plugin that owns out-of-process state (worktrees, tmux sessions,
  files written into a repo) and needs to run after boot's `recoverTasks()`.
  No call site exists yet — see `docs/plugins/README.md` §Limits.

`PLUGIN_API_VERSION = 0` is exported alongside these but nothing reads it at
runtime yet either — it's reserved for a future compatibility check.

## `PluginContext`

```ts
export interface PluginContext {
  readonly id: string; // manifest row id (bare, unqualified)
  readonly logger: PluginLogger;
  readonly settings: PluginSettingsScope;
  readonly kv: PluginKv;
  readonly workflows: WorkflowRegistrar;
  readonly integrations: IntegrationRegistrar;
  readonly harnesses: HarnessRegistrar;
  readonly compute: ComputeRegistrar;
  readonly http: HttpRegistrar;
  readonly facts: FactsRegistrar;
  readonly collections: CollectionsRegistrar;
  readonly services: ServicesRegistrar;
  readonly artifacts: ArtifactsApi;
  readonly agents: AgentRunner;
  readonly ui: UiRegistrar;
  readonly policy: PolicyRegistrar;
  readonly surfaces: SurfaceRegistrar;
  readonly fanout: FanOutApi;
  readonly catalog: CatalogReader;
  effect(dispose: () => void | Promise<void>): void;
}
```

One context is built per manifest row (`createPluginContext(row.id)` in
`context.ts`) and handed only to that row's `apply()`/`reconcile()`. Every
member:

| Member                                                             | What it does                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`ctx.logger`](#ctxlogger)                                         | structured logging — ungated                                       |
| [`ctx.settings`](#ctxsettings)                                     | this plugin's own settings blob — ungated                          |
| [`ctx.kv`](#ctxkv)                                                 | opaque key/value storage — throws on every call today              |
| [`ctx.workflows`](#ctxworkflows--ctxintegrations--ctxharnesses)    | registers a cron-schedulable workflow kind                         |
| [`ctx.integrations`](#ctxworkflows--ctxintegrations--ctxharnesses) | registers an outbound integration provider                         |
| [`ctx.harnesses`](#ctxworkflows--ctxintegrations--ctxharnesses)    | registers a coding-agent harness                                   |
| [`ctx.compute`](#ctxcompute)                                       | registers where a task's worktree/processes live                   |
| [`ctx.http`](#ctxhttp)                                             | registers a route at `/api/p/<pluginId>/...`                       |
| [`ctx.facts`](#ctxfacts)                                           | task-scoped, append-only observation log                           |
| [`ctx.collections`](#ctxcollections)                               | durable, keyed, schema-validated records                           |
| [`ctx.services`](#ctxservices)                                     | depend on a capability by name, not on a plugin package            |
| [`ctx.artifacts`](#ctxartifacts)                                   | files written into a task's worktree                               |
| [`ctx.agents`](#ctxagents)                                         | runs a headless, structured-output agent session                   |
| [`ctx.ui`](#ctxui)                                                 | declarative panel bindings, never components                       |
| [`ctx.policy`](#ctxpolicy)                                         | the one member that can deny a core action                         |
| [`ctx.surfaces`](#ctxsurfaces)                                     | registers a place octomux presents itself to a human               |
| [`ctx.fanout`](#ctxfanout)                                         | runs a step per item, with retries and a host-enforced cap         |
| [`ctx.catalog`](#ctxcatalog)                                       | reads what's installed — every plugin's registrations, plus core   |
| [`ctx.secrets`](#ctxsecrets)                                       | resolves a credential by name — the value never reaches the caller |
| [`ctx.effect()`](#ctxeffect)                                       | registers your own teardown, run in reverse order on unmount       |

### `ctx.logger`

```ts
interface PluginLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
```

A structural subset of pino's `Logger` — `packages/plugin-api` deliberately
doesn't depend on the `pino` type. In practice it's
`childLogger('plugin:<id>')` (`server/logger.ts`), so it follows the same
rotation/level/output rules as every other server log — see the root
`CLAUDE.md` "Logging" section.

### `ctx.settings`

```ts
interface PluginSettingsScope {
  get<T = Record<string, unknown>>(): Promise<T>;
  update(patch: Record<string, unknown>): Promise<void>;
}
```

Both async. `get()` returns `{}` if nothing was ever saved. `update()`
shallow-merges the patch onto the existing blob. Backed by
`getPluginSettings`/`updatePluginSettings` in `server/settings.ts`, scoped
under `settings.plugins.<row-id>` in the same settings file octomux already
uses, and **never validated** — your config shape is your own business.
External access: `PATCH /api/settings` with `{ "plugins": { "<id>": {...} } }`.

### `ctx.kv`

```ts
interface PluginKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  del(key: string): void;
  list(prefix?: string): Array<{ key: string; value: unknown }>;
}
```

Every method throws (`createKv` in `context.ts`) — plugin-owned key/value
storage hasn't landed. See README §"`ctx.kv` throws today".

### `ctx.workflows` / `ctx.integrations` / `ctx.harnesses`

```ts
interface WorkflowRegistrar {
  register(wf: PluginWorkflow): void;
}
interface IntegrationRegistrar {
  register(p: PluginIntegrationProvider): void;
}
interface HarnessRegistrar {
  register(h: PluginHarness): void;
}
```

`PluginWorkflow`, `PluginIntegrationProvider`, `PluginHarness` are all
`Record<string, unknown>` at the `@octomux/plugin-api` type level (the
package can't depend on the concrete server registry types). The actual
runtime shape your object needs, field by field, is below.

#### `WorkflowType` (`server/workflows/types.ts`)

| Field         | Type                                                       | Required by `ctx.workflows.register`?                                |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `kind`        | `string`                                                   | **yes** — non-empty, becomes the local half of `<row-id>:<kind>`     |
| `displayName` | `string`                                                   | no (not host-validated)                                              |
| `surfaces`    | `SurfaceKind[]` (`'session' \| 'artifact' \| 'feed'`)      | no                                                                   |
| `execution`   | `'session' \| 'task' \| 'chat'`                            | no                                                                   |
| `config`      | `JsonSchema`                                               | no                                                                   |
| `output`      | `JsonSchema`                                               | no                                                                   |
| `apiRouter`   | `express.Router`                                           | no, but **must be a function** (an Express router is one) if present |
| `trigger`     | `{ kind: 'cron' \| 'github' \| 'manual'; event?: string }` | no                                                                   |
| `run`         | `(ctx: RunContext) => Promise<void>`                       | no, but must be a function if present                                |

`RunContext` your `run` receives:

```ts
interface RunContext {
  repoPath: string;
  config: unknown; // validated against your `config` schema, defaults applied
  scheduleId?: string; // present for cron triggers
  event?: unknown; // present for github triggers
  trigger?: 'cron' | 'manual';
  model?: string | null; // per-schedule model override
  timeoutMs?: number | null;
}
```

#### `IntegrationProvider` (`server/integrations/types.ts`)

| Field          | Type                                                             | Required by `ctx.integrations.register`?                          |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `kind`         | `string`                                                         | **yes** — non-empty                                               |
| `displayName`  | `string`                                                         | no (not host-validated)                                           |
| `configSchema` | `JsonSchema`                                                     | no (not host-validated, but drives the UI form once you have one) |
| `events`       | `HookEventName[]`                                                | **yes**, must be an array                                         |
| `validate`     | `(config: unknown) => ValidationResult`                          | **yes**, must be a function                                       |
| `handler`      | `(envelope: HookEnvelope, config: unknown) => Promise<void>`     | **yes**, must be a function                                       |
| `test`         | `(config: unknown) => Promise<{ ok: boolean; message: string }>` | no, but must be a function if present                             |

`HookEventName` (`server/hook-types.ts`): `workflow_status_changed` |
`summary_updated` | `note_added` | `ref_added` | `ref_removed` |
`task_created` | `runtime_state_changed`.

`ValidationResult`: `{ ok: boolean; errors?: string[] }`.

An instance's `config` is set via `POST /api/integrations`
(`{ kind: "<row-id>:<local>", name, config }`) and `PATCH
/api/integrations/:id` — your `validate(config)` runs before it's persisted.
`handler(envelope, config)` runs when one of your declared `events` fires for
that integration's task.

#### `Harness` (`server/harnesses/types.ts`)

| Field                                            | Type                                          | Required by `ctx.harnesses.register`?                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                             | `string`                                      | **yes** — non-empty, becomes `<row-id>:<local>`                                                                                                                                          |
| `displayName`                                    | `string`                                      | no                                                                                                                                                                                       |
| `sessionIdMode`                                  | `'orchestrator-assigned' \| 'harness-issued'` | no                                                                                                                                                                                       |
| `newSessionId()`                                 | `() => string`                                | **yes**, must be a function                                                                                                                                                              |
| `buildLaunchCommand(opts)`                       | `(HarnessLaunchOpts) => string`               | **yes**                                                                                                                                                                                  |
| `buildResumeCommand(opts)`                       | `(HarnessResumeOpts) => string`               | **yes**                                                                                                                                                                                  |
| `buildContinueCommand(opts)`                     | `(HarnessResumeOpts) => string \| null`       | **yes**                                                                                                                                                                                  |
| `installHooks(worktreePath, baseUrl, hookToken)` | `(string, string, string) => Promise<void>`   | **yes**                                                                                                                                                                                  |
| `uninstallHooks(dirPath)`                        | `(string) => Promise<void>`                   | **yes**                                                                                                                                                                                  |
| `resolveFlags(settings)`                         | `(OctomuxSettings) => string`                 | **yes**                                                                                                                                                                                  |
| `validateSettings(blob)`                         | `(unknown) => Record<string, unknown>`        | **yes**                                                                                                                                                                                  |
| `validateAgentName(name)`                        | `(string) => string`                          | on the interface, **not** in the required-field check, **not called via `h.validateAgentName()` anywhere** — every call site imports the free function from `harnesses/types.ts` instead |
| `postLaunch(target)`                             | `(string) => Promise<void>`                   | no — optional, called after launch for harnesses with an interactive first-run gate                                                                                                      |
| `supportsClaudePlugins`                          | `boolean`                                     | no — descriptive only, nothing reads it yet                                                                                                                                              |
| `buildPromptDelivery(baseCmd, promptFile)`       | `(string, string) => string`                  | no — **unwired**, no call site reads it yet                                                                                                                                              |
| `attachMcp(flags, worktreePath, configPath)`     | `(string, string, string) => string`          | no — **unwired**. If you implement it: quote your own inputs (`shellQuoteSingle` in `server/shell-quote.ts`) — this is a real shell-injection surface if you don't                       |
| `sendMessage(target, text)`                      | `(string, string) => Promise<void>`           | no — **unwired**. Same quoting caveat as `attachMcp`                                                                                                                                     |

The eight bold-"yes" functions are exactly `HARNESS_REQUIRED_FN_FIELDS` in
`server/plugins/context.ts` — every member core calls unconditionally on a
hot path (task launch, hook install/uninstall, settings validate/merge, flag
resolution).

### `ctx.http`

```ts
interface HttpRegistrar {
  route(method: HttpMethod, path: string, handler: PluginRouteHandler): void;
}
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type PluginRouteHandler = (req: PluginRequest, res: PluginResponse) => void | Promise<void>;
interface PluginRequest {
  readonly params: Record<string, string>;
  readonly query: Record<string, unknown>;
  readonly body: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}
interface PluginResponse {
  status(code: number): PluginResponse;
  json(body: unknown): void;
}
```

Routes are DATA in a lookup table (`server/plugins/http-registry.ts`), not an
Express `Router` — that is the whole reason hot reload is possible at all.
`WorkflowType.apiRouter` hands a plugin a real `Router`, and express 5 cannot
unmount one; a route registered here is a row that ONE permanently-mounted
parent router looks up (`createPluginParentRouter()`, mounted at `/api/p` by
`server/api.ts`), so removing a plugin just deletes its rows — nothing was
ever mounted.

A plugin declares a path relative to its own namespace: `ctx.http.route('GET',
'/coverage/:task', handler)` serves at `/api/p/<pluginId>/coverage/:task`.
Dispatch is a hand-rolled segment matcher, not `path-to-regexp` — **first
match wins with no specificity ranking**, so register a literal route
(`/coverage/latest`) before a param route that would otherwise shadow it
(`/coverage/:task`).

`PluginRequest`/`PluginResponse` are deliberately not express's own types — a
types-only package must not depend on express, and the host owns the adapter.
`headers` is lowercased, the way express normalizes them — without it a
plugin route has no way to authenticate a caller at all.

```js
ctx.http.route('GET', '/coverage/:task', (req, res) => {
  res.status(200).json({ pct: lookupCoverage(req.params.task) });
});
```

Gate: `http.route`. Unmount: every route this plugin registered is dropped
(`unregisterPluginRoutes`).

**Read the warning.** A route handler receives the raw request headers,
including the remote-mode auth token of whoever called it, and `/api/p/*`
sits behind `remoteAuthMiddleware` like every other API route — nothing
sandboxes what a handler does with that header.

### `ctx.catalog`

```ts
interface CatalogEntry {
  id: string; // bare plugin id, or 'core'
  kind: 'plugin' | 'core';
  provides: string[]; // 'workflow:demo:changelog' | 'harness:demo:foo' | …
  source: string; // 'pkg@1.2.3' | '/abs/local/path' | 'built-in'
}
interface CatalogReader {
  list(): CatalogEntry[];
}
```

```js
const installed = ctx.catalog.list();
ctx.logger.info({ installed: installed.map((e) => e.id) }, 'who else is here');
```

Read-only — `ctx.catalog` has exactly one method, `list()`. There is no write
path and no override path: reading what is installed is a query, not an
implementation choice, so this is not a fourth registrar and it never will
grow a `register()`. See [`#not-seams`](#not-seams).

Ordering caveat: the loader (`server/plugins/loader.ts`) only marks a row
mounted — what `ctx.catalog` iterates — AFTER its `apply()` returns
successfully. Called from inside your own `apply()`, `ctx.catalog.list()`
never includes yourself, even in a single-plugin manifest; it includes
siblings that finished mounting earlier (manifest order) and always includes
`core`. Call it later — a route handler, a `run`, anything that executes
after `apply()` finishes — to see yourself.

### `ctx.secrets`

Credentials live in a named store, never in `schedules.config_json`. A plugin
resolves one **by name**; the value is produced at the point of use and is never
returned by any HTTP route.

```ts
const names = await ctx.secrets.list(); // metadata only, ungated
const token = await ctx.secrets.resolve('slack-bot');
```

Gate: `secrets.read` on `resolve`. `list` is ungated, matching `facts.read` and
`artifacts.list` — knowing a secret exists is not knowing its value.

Config referencing uses `${secret:NAME}`, mirroring `${env:VAR}`. Unlike
`${env:}`, an unknown name **throws** rather than degrading to `''`: sending an
empty credential surfaces as a 401 three layers away, which is worse than
failing here.

Resolution happens at two core egress points only — the hook dispatcher and
compute config. It is deliberately **not** wired into schedule prompt
interpolation: that path feeds `{{configKey}}` into the agent's prompt, and
resolving there would hand the credential to the agent, which is the exact
failure the store exists to prevent.

Values are redacted from logs at the stream destination and from
`runs.result_json`, so no call site has to remember.

### `ctx.facts`

```ts
interface FactsRegistrar {
  define(def: FactTypeDefinition): void;
  put(taskId: string, localType: string, payload: unknown): Promise<void>;
  read(taskId: string, opts?: FactQuery): Promise<Fact[]>;
  watch(qualifiedType: string, onFact: (fact: Fact) => void): () => void;
}
interface FactTypeDefinition {
  type: string; // BARE local type. The host qualifies it to `<pluginId>:<type>`.
  schema: Record<string, unknown>; // JSON Schema for the payload — also drives ctx.ui.
}
interface FactQuery {
  type?: string; // Qualified fact type to filter on.
  sinceSeq?: number; // Only facts with `seq` strictly greater than this.
}
interface Fact {
  seq: number;
  taskId: string;
  type: string; // Qualified — `core:diff`, `coverage-bot:coverage`.
  payload: unknown;
  createdAt: string;
}
```

A typed, task-scoped, append-only log every plugin can write to and read
from. Before this the only wire between plugin types was `HookEnvelope`:
seven fixed event names, outbound only, fire-and-forget, with no read path at
all. This is an observation log, not event sourcing — tasks remain the
source of truth.

`define()` declares a BARE local type; the host qualifies it to
`<pluginId>:<type>` (`qualify()`), so a plugin can add `coverage-bot:coverage`
and can never overwrite `core:diff`. Core itself publishes exactly two fact
types today — `core:review.published` and `core:policy.decision`
(`CORE_FACT_TYPES`, `server/plugins/facts.ts`) — a plugin reads those, never
writes them.

`put(taskId, localType, payload)` validates `payload` against the type's
schema and rejects a violation with the plugin/type named in the error.
`read(taskId, opts?)` is **unscoped** — every plugin's facts on that task,
not just this one's own, same discipline as `ctx.collections.query`.
`watch(qualifiedType, cb)` takes a QUALIFIED type and returns an unsubscribe
that is also auto-disposed on unmount.

```js
ctx.facts.define({
  type: 'coverage',
  schema: { type: 'object', required: ['pct'], properties: { pct: { type: 'number' } } },
});
await ctx.facts.put(taskId, 'coverage', { pct: 87.4 });
const all = await ctx.facts.read(taskId);
```

Gates: `facts.define`, `facts.put`. `read`/`watch` are ungated.

Unmount drops this plugin's fact **type definitions**, never facts already
written — those die with their task, not with the plugin. Watchers this
plugin registered via `ctx.facts.watch` are auto-unsubscribed; a _sibling_
plugin's watcher on one of this plugin's types is deliberately left running.
`unregisterPluginFacts` can only reach watchers registered by the plugin
unmounting — a reload (not an unload) redefines the same qualified type
moments later, so tearing down every watcher on it would silently kill a
sibling's live subscription with no error and no log
(`server/plugins/facts.ts`).

### `ctx.collections`

```ts
interface CollectionsRegistrar {
  define(def: { name: string; schema: Record<string, unknown>; key: string }): void;
  put(collection: string, record: unknown): Promise<void>;
  query(collection: string, q?: QuerySpec): Promise<unknown[]>;
  watch(qualifiedName: string, cb: (record: unknown) => void): () => void;
}

interface QuerySpec {
  where?: Record<string, unknown>; // exact match on top-level record fields
  orderBy?: string; // top-level record field; default `updatedAt`
  order?: 'asc' | 'desc'; // default `asc`
  limit?: number;
  offset?: number;
}
```

Durable, keyed, schema-validated records. The half of plugin storage
`ctx.facts` deliberately is not: a fact is an append-only entry scoped to one
task and deleted with it, while a collection record has no task at all and
survives every task, every plugin reload, and the plugin's own uninstall.

```js
export default {
  async apply(ctx) {
    ctx.collections.define({
      name: 'baselines',
      key: 'repo',
      schema: {
        type: 'object',
        required: ['repo', 'pct'],
        properties: { repo: { type: 'string' }, pct: { type: 'number' } },
        additionalProperties: false,
      },
    });

    // Upserts on `repo`. Writing the same repo twice replaces, never appends.
    await ctx.collections.put('baselines', { repo: '/src/api', pct: 87.4 });

    const low = await ctx.collections.query('baselines', {
      orderBy: 'pct',
      order: 'asc',
      limit: 10,
    });
  },
};
```

Manifest grants: `collections.define` for `define`, `collections.write` for
`put`. `query` and `watch` are ungated, like `facts.read`.

Rules worth knowing before you design against it:

- **Names qualify**, exactly like fact types — you declare `baselines`, it
  stores `<your-plugin-id>:baselines`. A `core:` name is refused.
- **`put` takes a BARE name.** Cross-plugin writes are out of scope; a
  qualified name here is an error, not a write to someone else's collection.
- **`query` takes bare OR qualified**, and reads are unscoped — you can read
  a sibling's collection by its qualified name, same as `facts.read` reads
  every plugin's facts on a task.
- **The key must be a top-level `string` or finite `number` field** named by
  `def.key`. A record missing it, or holding an object there, is rejected.
- **`QuerySpec` is deliberately tiny.** Exact matches, an order, a window.
  No operators, no joins, no aggregates. A plugin that needs those has
  outgrown this API rather than found a gap in it.
- **Unmount drops the definition, never the rows.** Durability is the whole
  point, and a hot reload re-runs `apply()` expecting its records still
  there. Redefining a name with a different schema on reload is honoured (the
  compiled-schema cache is busted), but there is **no schema migration** of
  records already stored — that is explicitly out of scope.
- Not `ctx.kv`: kv is opaque per-plugin blobs keyed by a string (and still
  throws — see README §Limits). This is schema-validated queryable records.

This is also what makes a durable UI panel possible. `ctx.ui.panel()` binds to
either a `fact` or a `collection`:

```js
ctx.ui.panel({ slot: 'task.panel', fact: 'coverage', as: 'stat', value: 'pct' });
ctx.ui.panel({ slot: 'nav.section', collection: 'baselines', as: 'table' });
```

A fact-bound panel renders that task's facts; a collection-bound panel renders
the collection's records, with no task involved. Records reach the SPA over
`GET /api/plugin-collections/<qualified-name>`.

### `ctx.services`

```ts
interface ServicesRegistrar {
  provide(name: string, impl: unknown): void;
  require<T = unknown>(name: string): ServiceHandle<T>;
}
interface ServiceHandle<T = unknown> {
  readonly name: string;
  get(): T; // resolves live — throws if nothing provides `name`
}
```

Dependency by CAPABILITY, not by package name. A plugin says "I need
something that can send chat messages" (`ctx.services.require('chat.send')`)
instead of importing `octomux-plugin-slack`; a provider says "I am that"
(`ctx.services.provide('chat.send', impl)`). Neither one names the other.

**Service names are the one thing in this API that is NOT qualified.**
Everything else a plugin registers is prefixed `<pluginId>:` so two plugins
can't collide; a service name is the opposite on purpose — `chat.send` has to
mean the same string on both sides of the contract, or the whole idea
collapses back into naming packages.

**First provider wins.** Two plugins may `provide` the same name — the one
that appears EARLIER in `octomux.yml` is live, the other queues behind it and
takes over if the first one unmounts. There is deliberately no `prefer:` key;
reordering the two manifest rows is how you choose.

**Resolution is at mount, not at call.** `require()` just records the
dependency. `server/plugins/loader.ts` checks every requirement only after the
whole manifest has been applied, so a consumer may be listed before its
provider. A name nothing provides fails only that plugin (and anything that
transitively depended on it) as a `phase: 'apply'` load-report entry naming
the plugin and the service — the same shape an ungranted capability produces.
It never fails the boot.

```js
// provider
export default {
  apply(ctx) {
    ctx.services.provide('chat.send', {
      async send(text) {
        /* ... */
      },
    });
  },
};

// consumer — may load before or after the provider's row
export default {
  apply(ctx) {
    const chat = ctx.services.require('chat.send');
    ctx.http.route('post', '/notify', async (req, res) => {
      await chat.get().send(req.body.text); // resolves live, on every call
      res.sendStatus(204);
    });
  },
};
```

Gate: `services.provide`. `require` is ungated — declaring a dependency is a
statement about your own plugin, not a reach into anyone else's, same
reasoning as `facts.read`/`catalog.list`.

Providing plugins show up in `ctx.catalog.list()` as `service:<name>` entries.

**Known limitation.** The mount-time check is boot-only: `octomux plugins
reload <id>` does not re-run it. A hot-reloaded plugin with an unmet
requirement mounts anyway and throws at its first `handle.get()` instead of
failing at load time.

### `ctx.artifacts`

```ts
interface ArtifactsApi {
  write(taskId: string, artifact: ArtifactInput): Promise<ArtifactEntry>;
  list(taskId: string): Promise<ArtifactEntry[]>;
}
interface ArtifactInput {
  name: string; // `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — no separators, no `..`
  mime: string; // e.g. `text/markdown`, `application/json`, `image/svg+xml`
  body: string;
}
interface ArtifactEntry {
  pluginId: string; // artifacts are namespaced by the writing plugin
  name: string;
  mime: string;
  size: number; // utf8 byte length of the body
  updatedAt: string; // `YYYY-MM-DD HH:MM:SS` UTC — sqlite `datetime('now')` shape
  url: string; // `/api/tasks/<taskId>/artifacts/<pluginId>/<name>`
}
```

A METHOD on `ctx`, not a registrar — nobody needs a different artifact
implementation, they need to write one. `write(taskId, {name, mime, body})`
drops a file at `<worktree>/.octomux/artifacts/<pluginId>/<name>`, with
metadata in a sibling `index.json` (since `mime` isn't recoverable from the
filesystem alone). Rejects if the task has no worktree yet. `name` must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — no path separators, no `..`.

Artifacts land in the task's git worktree — they diff, and they outlive both
the plugin and a DB wipe. There is no unmount teardown: an artifact is output
a plugin already produced, not a live registration. `list(taskId)` is
**unscoped**, like `facts.read` — every plugin's artifacts on that task, not
just this one's own. `server/services/run-detail.ts` surfaces them on
`GET /api/runs/:id`, so a plugin's output reaches the run detail view with no
further core change.

```js
await ctx.artifacts.write(taskId, {
  name: 'report.md',
  mime: 'text/markdown',
  body: '# Coverage report\n\n87.4%',
});
```

Gate: `artifacts.write`. `list` is ungated.

## `ctx.compute`

```ts
interface ComputeRegistrar {
  register(p: PluginCompute): void;
}
```

Registers a **compute provider** — the seam that decides _where a task's git
worktree lives and where its processes run_ (`server/compute/types.ts`). It
is **not** a pluggable isolation strategy: every provider still gets a real
git worktree per task, that guarantee is not negotiable. A provider only
changes which machine that worktree — and every process touching it — lives
on. See [`examples/ssh-compute`](./examples/ssh-compute) for a complete,
tested reference provider that runs a task over SSH.

`PluginCompute` is `Record<string, unknown>` at the `@octomux/plugin-api`
type level, same reason as the other three registrars. The concrete runtime
shape:

| Field    | Type                                                                 | Required by `ctx.compute.register`?                                                               |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `kind`   | `string`                                                             | **yes** — non-empty, becomes the local half of `<row-id>:<kind>`                                  |
| `create` | `(task: Task, ctx: ComputeCreateContext) => Promise<ComputeSession>` | **yes**, must be a function — `sessionFor()` dereferences it unconditionally on every task launch |
| `resume` | `(task: Task, ctx: ComputeCreateContext) => Promise<ComputeSession>` | no, must be a function if present — the host falls back to `create()` when absent                 |

Same qualification and warn-and-keep-first duplicate policy as
`ctx.integrations`/`ctx.harnesses` (`server/compute/registry.ts`): you
declare `kind: 'ssh'`, the kind every other part of octomux sees is
`<row-id>:ssh`. Core providers (currently just `local`) register directly,
outside `ctx.compute`, and are frozen against redefinition before any plugin
loads — a plugin can never redefine `local`.

### `ComputeSession` (`server/compute/types.ts`)

What `create`/`resume` must return — the whole surface the rest of octomux
uses instead of talking to tmux/git/fs/pty directly for a task on this
provider:

```ts
interface ComputeSession {
  readonly kind: string; // the provider kind that made this session
  readonly taskId: string;
  readonly repoPath: string; // the git repo root ON THE COMPUTE
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>; // throws non-zero unless opts.allowFailure
  tmux(args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  spawn(opts: SpawnOptions): Promise<ProcessHandle>; // interactive pty, for xterm.js streaming
  readonly files: ComputeFiles; // exists/mkdirp/read/write/chmod/copy/rm, all async
  dispose(opts?: { destroy?: boolean }): Promise<void>;
}
```

`tmux`'s signature must match `execTmux` (`server/tmux-bin.ts`) exactly,
including that it **throws** on a non-zero exit with the error carrying
`.stderr` — call sites read that field directly. `dispose({ destroy: true })`
additionally tears down whatever this session's provider owns (a no-op for
`local`); without `destroy` it only releases the host's own handles.

### `ComputeCreateContext`

What `create`/`resume` receive as their second argument — deliberately the
**only** runtime capability a compute provider gets, since `@octomux/plugin-api`
is types-only and a plugin has no other path to a real process:

```ts
interface ComputeCreateContext {
  config: Record<string, unknown>; // settings.compute[<qualified-kind>], env-resolved
  secrets: Record<string, string>; // resolved server-side, handed ONLY to create()/resume()
  logger: PluginLogger;
  host: ComputeHost; // the server's own machine — build your transport on this
  execBackedFiles(exec: ComputeSession['exec']): ComputeFiles; // a ComputeFiles for free, over any exec
}

interface ComputeHost {
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>; // runs argv on the SERVER's own machine
  spawnPty(opts: SpawnOptions): Promise<ProcessHandle>; // a local pty on the SERVER's own machine
}
```

`host` is the reason a remote provider doesn't need a new dependency: every
remote provider (ssh, docker, a cloud CLI) is fundamentally "run a local
command that proxies to the remote box", and `host.exec`/`host.spawnPty` is
that local command surface, already wired into the same observable/disposable
process machinery as everything else octomux spawns. Prefer it over
`node:child_process` directly — nothing stops a plugin from importing that
(plugins run in-process with full Node/Bun privileges), but doing so opens a
second, untracked spawn path.

`execBackedFiles(exec)` builds a complete `ComputeFiles` — `exists`, `mkdirp`,
`read`, `write`, `chmod`, `copy`, `rm` — purely by shelling `test`/`mkdir`/
`cat`/`chmod`/`cp`/`rm` through whatever `exec` you pass it. A remote
provider gets working file operations in one line:
`files: ctx.execBackedFiles(exec)`.

**The credential invariant.** `secrets` is resolved server-side from
`settings.compute[<qualified-kind>].secrets`, with `${env:VAR}` placeholders
expanded (`computeConfigFor()`, `server/settings.ts` — same convention
integration providers use). It exists to build **transport** arguments only —
an SSH `-i <keyfile>`, a cloud API token used to authenticate the CLI call
that provisions a box. **It must never reach the agent**: not folded into a
remote command string, not set as an env var on a spawned process, not
written into the worktree. This is the actual security property compute
providers exist to uphold — `docs/plugins/examples/ssh-compute`'s test file
asserts it directly (register the provider with a recognizable secret, drive
`create()` and a few `exec()`s, assert the secret string appears only in the
transport argv).

## `ctx.agents`

```ts
interface AgentRunOptions {
  input: string;
  outputSchema: object; // JSON Schema the structured result must conform to
  model?: string | null;
  timeoutMs?: number; // default 300_000
  /** Defaults to a fresh ephemeral scratch dir. No git, no worktree. */
  workspaceDir?: string;
}
interface AgentRunner {
  run<T = unknown>(opts: AgentRunOptions): Promise<T>;
}
```

Runs a headless agent and hands you back structured JSON — for a plugin that
needs an LLM to read something and answer, not write code. `run()` wires
straight to the host's `runAgentSession()` primitive
(`server/agent-session/session.ts`) with the default harness and the **pty** substrate, the same
primitive `server/services/session-vertical-service.ts` already uses to run
scheduled workflow kinds. The agent is told to call the `submit_result` MCP
tool with a result matching `outputSchema`; `run()` resolves with that
result.

```js
async function classify(ctx, ticketBody) {
  return ctx.agents.run({
    input: `Classify this support ticket:\n\n${ticketBody}`,
    outputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['bug', 'feature', 'question'] },
        confidence: { type: 'number' },
      },
      required: ['category', 'confidence'],
    },
    timeoutMs: 60_000,
  });
}
```

- **Gated.** Your manifest row needs `grants: [agents.run]` or the call
  throws — see "Capability grants" in the root `CLAUDE.md`.
- **Explicitly git-free.** No worktree, no branch, no tmux session — that's
  the _task_ lifecycle, for agents that write code. `run()` defaults to a
  fresh empty scratch dir, which is also a clean room: no CLAUDE.md, no repo
  checkout, no project skills bleeding into the prompt. Pass `workspaceDir`
  if the agent genuinely needs to see a checkout.
- **pty only** — not reattachable, doesn't survive a host restart, no tmux
  window a human can attach to.
- **No concurrency cap in the host.** A plugin that fans out owns its own
  limiter.
- **DB-free.** A plugin run is not a schedule run and gets no `runs` row.
- `timeoutMs` (default 5 min) bounds the wait — a session that never submits
  a result rejects rather than hanging.
- Unmounting the plugin stops _new_ runs; an already in-flight run settles
  on its own and is not awaited by teardown.

## `ctx.fanout`

Run a step **per item**, not once per schedule fire. One cron fire is one
session and one output blob; a pipeline is "do this to each of N things".

```ts
interface FanOutApi {
  run<T, R>(spec: FanOutSpec<T, R>): Promise<FanOutRunSummary>; // needs `fanout.run`
  status(runId: string): Promise<FanOutRunStatus | undefined>; // ungated read
  list(name?: string): Promise<FanOutRunSummary[]>; // ungated read
}

type FanOutSource<T> =
  | { items: readonly T[] } // a plain array — e.g. the previous step's output
  | { collection: string; query?: Record<string, unknown> } // a ctx.collections query
  | { resume: string }; // redrive a previous run

interface FanOutSpec<T, R> {
  name: string; // BARE — qualified to `<pluginId>:<name>`
  source: FanOutSource<T>;
  each: (item: T, meta: FanOutItemMeta) => Promise<R>;
  key?: (item: T) => string; // default: stable hash of the item
  concurrency?: number; // clamped DOWN to the host ceiling, never up
  maxAttempts?: number; // default 3, minimum 1
  backoffMs?: number; // default 1000 → 1s, 2s, 4s …
}
```

```js
const summary = await ctx.fanout.run({
  name: 'enrich',
  source: { items: leads },
  key: (lead) => lead.id,
  concurrency: 3,
  async each(lead, { attempt, signal }) {
    return enrich(lead, { signal });
  },
});
// { runId, name: 'funnel:enrich', status: 'failed', total: 60,
//   succeeded: 58, dead: 2, pending: 0, … }

// Redrive just the two that dead-lettered:
await ctx.fanout.run({ name: 'enrich', source: { resume: summary.runId }, each });
```

**Per-item status is persisted** in `fanout_runs` / `fanout_items`, so a partial
run is legible — `GET /api/fanout/runs` and `GET /api/fanout/runs/:id` — and
resumable. `each` throwing schedules a retry with bounded exponential backoff;
an item that exhausts `maxAttempts` is **dead-lettered** (`status: 'dead'`) and
the rest of the run carries on untouched.

**The concurrency cap is the host's, and it is global.** One semaphore is shared
across every fan-out run of every plugin, sized by
`settings.fanout.maxConcurrency` (default 4). Three plugins each asking for 4
get 4 in total, not 12. That placement is deliberate: `ctx.agents.run()` stays a
thin accessor with no scheduling policy in it, and fan-out is where scheduling
policy belongs — an uncapped fan-out over a subscription-backed harness is the
runaway case, saturating the operator's rate limits with no backpressure and no
signal.

`meta.signal` is aborted when your plugin unmounts. Unmount stops the scheduler
immediately and does **not** await in-flight handlers (a handler may be a
multi-minute agent session), so honour the signal in anything long-running.
Items interrupted that way go back to `pending`; a later `{ resume: runId }`
picks them up. `run()` resolves with a `canceled` summary rather than rejecting.

Deliberately **not** a DAG. There is no step composition — chain by writing to a
collection and querying it from the next step. There is also no HTTP redrive
route: a redrive needs your live `each` closure, which cannot be persisted.
Expose one yourself with `ctx.http.route` if you want a button.

Until `ctx.collections` lands, a `{ collection }` source throws with a message
saying so — pass `{ items }` in the meantime.

### `ctx.policy`

```ts
interface PolicyRegistrar {
  intercept(point: PolicyPoint, hook: PolicyHook): void;
}
type PolicyPoint = 'task.launch' | 'harness.resume' | 'review.publish' | 'integration.send';
interface PolicyIntent {
  readonly point: PolicyPoint;
  readonly taskId?: string; // present for task-scoped points
  readonly repoPath?: string;
  readonly data: Readonly<Record<string, unknown>>; // earlier hooks' patches already applied
}
type PolicyDecision =
  | void
  | { deny: string; patch?: never }
  | { patch: Record<string, unknown>; deny?: never };
type PolicyHook = (intent: PolicyIntent) => PolicyDecision | Promise<PolicyDecision>;
```

The one member of `ctx` that can say **no**, not just add. Every other
registrar is additive — a workflow, a route, a fact, a panel. `intercept`
runs a hook between "a run wants to start" and "a run starts," and that hook
may deny it with a reason or patch it on the way through.

| point              | `data` keys                           | patchable |
| ------------------ | ------------------------------------- | --------- |
| `task.launch`      | `harnessId`, `model`, `agent`         | `model`   |
| `harness.resume`   | `harnessId`, `model`, `prompt`        | `model`   |
| `review.publish`   | `verdict`, `bodyLength`               | `verdict` |
| `integration.send` | `integrationKind`, `event`, `payload` | `payload` |

Hooks for a point run in registration order. The **first `deny` short-circuits**
— later hooks never run. A `patch` is merged into `intent.data` and the next
hook sees the patched values; a key a call site doesn't list as patchable
above is ignored, since a patch is a request and core decides what it
honours. A hook that throws or exceeds the host timeout (5s,
`POLICY_HOOK_TIMEOUT_MS` in `server/plugins/policy.ts`) is logged and treated
as no opinion — **fails open**, so a crashing plugin can't wedge every
launch in the install.

A deny or a patch on a task-scoped intent is recorded twice: a
`core:policy.decision` fact (via `ctx.facts`) and a `task_updates` row of
kind `policy`, which shows up in the task's Activity panel. Each write is
best-effort — a failed audit write is logged and never reverses the decision
that already happened.

There is deliberately no `task.merge` point: core octomux never merges a PR
(`server/poller/merged-pr.ts` only _observes_ merges that already happened on
GitHub), so there's no call site to gate.

```js
ctx.policy.intercept('task.launch', (intent) => {
  if (intent.data.harnessId === 'cursor' && isOffHours()) {
    return { deny: 'cursor tasks are paused outside business hours' };
  }
});
```

Gate: `policy.intercept`. Unmount: every hook this plugin registered is
removed (`unregisterPluginPolicy`).

**Not containment.** A deny is a coordination and audit signal, not a
security boundary — a plugin runs in-process with the DB handle, every
credential, and `process.env`, and nothing stops it from calling the same
functions core calls and bypassing its own hook entirely.

### `ctx.ui`

```ts
interface UiRegistrar {
  panel(binding: UiPanelBinding): void;
}
type UiSlot =
  | 'task.panel'
  | 'task.badge'
  | 'board.card'
  | 'nav.section'
  | 'run.detail'
  | 'settings.card';
type UiRenderer = 'stat' | 'table' | 'timeline' | 'badge' | 'markdown' | 'json' | 'diff' | 'log';

interface UiFactPanelBinding {
  slot: UiSlot;
  as: UiRenderer | string; // unknown renderer degrades to `json`, never a blank
  value?: string;
  delta?: string;
  title?: string;
  fact: string; // BARE local fact type — qualified like `facts.define`
  collection?: never;
}
interface UiCollectionPanelBinding {
  slot: UiSlot;
  as: UiRenderer | string;
  value?: string;
  delta?: string;
  title?: string;
  collection: string; // BARE local collection name — qualified like `collections.define`
  fact?: never;
}
type UiPanelBinding = UiFactPanelBinding | UiCollectionPanelBinding;
```

Declarative BINDINGS, never components. A plugin ships zero browser
JavaScript and needs no build step — a binding names a slot, a renderer, and
a fact type or collection; the client owns every renderer and looks it up by
name. There is deliberately no `ctx.ui.component()` and no custom sidebar:
that ceiling is what keeps a panel written today renderable on a surface
that doesn't exist yet — see `ctx.surfaces` below.

`UiPanelBinding` is a union: exactly one of `fact` (bare local fact type) or
`collection` (bare local collection name). `registerPluginUiPanel`
(`server/plugins/ui-registry.ts`) rejects a binding that sets neither or
both. An unknown `as` renderer name is not rejected at registration — the
client (or a `ctx.surfaces` implementation) degrades it to `json` rather
than dropping the panel.

```js
ctx.ui.panel({ slot: 'task.panel', fact: 'coverage', as: 'stat', value: 'pct' });
ctx.ui.panel({ slot: 'nav.section', collection: 'baselines', as: 'table' });
```

Gate: `ui.panel`. Unmount: every contribution this plugin registered is
removed (`unregisterPluginUi`) — the panel vanishes with no restart.
Bindings are served to the client at `GET /api/plugin-ui/contributions`.

## `ctx.surfaces`

```ts
interface SurfaceRegistrar {
  register(surface: SurfaceDefinition): void; // requires the `surfaces.register` grant
}
```

Registers a **surface** — a place octomux presents itself to a human. Core
already speaks four: `web`, `cli`, `slack`, `telegram`. All four are frozen
before any plugin loads, same as `local` under `ctx.compute` — a plugin can
never redefine one. `ctx.surfaces.register` is the seam that adds a fifth
without editing core, and it works only because `ctx.ui` panels are
declarative **bindings**, not components (see `UiRegistrar` above): a
binding names a fact type and a renderer, never a DOM node, a Block Kit
block, or an ANSI escape, so a panel written before your surface existed
renders on it unchanged. See
[`examples/discord-surface`](./examples/discord-surface) for a complete
worked example.

```ts
interface SurfaceDefinition {
  kind: string; // local id — becomes "<row-id>:<kind>"
  renderers: Array<UiRenderer | string>; // renderer names this surface draws natively
  fallback?: string; // renderer for anything else it can't draw; default 'json'
  render?(panel: SurfacePanel): string | undefined; // REQUIRED for a plugin surface
  prompt?(ask: SurfacePrompt): Promise<string | undefined>; // absent → read-only
}
```

| Field       | Type                                                   | Required by `ctx.surfaces.register`?                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | `string`                                               | **yes** — non-empty, becomes the local half of `<row-id>:<kind>`                                                                                                                                                          |
| `renderers` | `Array<UiRenderer \| string>`                          | **yes**, must be an array                                                                                                                                                                                                 |
| `fallback`  | `string`                                               | no — defaults to `'json'`                                                                                                                                                                                                 |
| `render`    | `(panel: SurfacePanel) => string \| undefined`         | **yes for a plugin surface** — the registrar rejects one that omits it. Core's `web` is the one exception: the browser owns every renderer and reads the binding table over REST, so it registers with no `render` at all |
| `prompt`    | `(ask: SurfacePrompt) => Promise<string \| undefined>` | no — absent means the surface is **read-only**                                                                                                                                                                            |

### The renderer contract

A surface declares the renderer names it draws (`renderers`). The host
resolves every panel against that list **before** calling `render` — your
`render` implementation never sees a renderer name outside what it declared:

| Field            | Meaning                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `panel.as`       | what the `ctx.ui` binding asked for                                                                                             |
| `panel.renderer` | what this surface actually draws — `panel.as` if `renderers` includes it, otherwise the surface's `fallback` (default `'json'`) |

Degraded, never dropped, never blank — the same rule the web client has
always applied to an unknown renderer name. A surface that declares
`renderers: ['markdown']` gets `renderer: 'markdown'` for a `stat` panel it
never asked to draw as markdown; it does not get skipped and `render` is not
called with `'stat'`.

### Read-only surfaces

`prompt` is optional. A surface without one is **read-only**: it draws
panels and cannot ask a question. Calling `promptOn()` against a read-only
surface **throws**, naming the surface — a question nobody can answer is a
wedged run, not something to swallow silently.

**All four core surfaces are read-only today.** octomux's only
human-question path is the card-based approval gate
(`server/orchestrator/gate.ts`), which is DB-backed and predates this
registrar — nothing rewired it onto `ctx.surfaces`. The registrar exists so a
_plugin_ surface can implement `prompt`; no core surface does yet. See
[`examples/discord-surface`](./examples/discord-surface) for a surface that
does implement it.

### Qualification and freezing

Same rule as every other registrar: you declare `kind: 'discord'`, the kind
the rest of octomux sees is `<row-id>:discord` — `qualify()`,
`server/plugins/qualify.ts`. `CORE_SURFACE_KINDS = ['web', 'cli', 'slack',
'telegram']` is frozen before any plugin loads, the same pattern
`freezeCoreHarnesses()`/`CORE_COMPUTE_KINDS` use — a plugin can declare
`kind: 'slack'` but it registers as `<row-id>:slack`, never collides with
core's bare `slack`.

### Capability grant and unmount

`register()` requires the `surfaces.register` grant in the manifest row's
`grants:` list — omitted, and the registrar throws at registration and the
row lands in the load report as an `apply`-phase failure naming the plugin
and the capability, same as every other gated registrar
(`server/plugins/context.ts`, `server/plugins/grants.ts`). A surface is
deregistered when its plugin unmounts, same as a workflow, a harness, or a
compute provider — nothing keeps serving a dead plugin's panels.

### `SurfacePanel` and `SurfacePrompt`

```ts
interface SurfacePanel {
  pluginId: string; // manifest row id of the plugin that declared the binding
  slot: UiSlot;
  factType: string; // qualified — "<pluginId>:<fact>"
  as: string; // renderer the binding asked for
  renderer: string; // renderer this surface actually draws — `as`, or the fallback
  value?: string;
  delta?: string;
  title?: string;
  facts: Fact[]; // this binding's facts on the task being rendered, oldest first
}

interface SurfacePrompt {
  taskId?: string; // present when the question is about a specific task
  question: string;
  choices?: string[]; // offered answers; absent means free text
}
```

`render(panel)` returns the text this surface's transport takes — mrkdwn for
Slack, plain text for CLI/Telegram, Discord-flavoured markdown for a Discord
surface. Returning `undefined` means "nothing to show for this panel" and it
is omitted, not rendered as an empty block.

### `ctx.effect()`

```ts
effect(dispose: () => void | Promise<void>): void;
```

Registers a teardown callback, run in **reverse** registration order when the
plugin unmounts — the Cordis model, so a later effect never observes an
earlier one already gone (`disposePluginContext()`, `server/plugins/context.ts`).

Everything registered _through_ `ctx` — a workflow kind, a route, a fact
type, a policy hook — is already tracked and undone automatically by the
matching `unregisterPlugin*` call (`server/plugins/lifecycle.ts`).
`ctx.effect()` covers what the plugin owns **outside** `ctx`: a
`setInterval`, a filesystem watcher, an open socket. Anything not routed
through `ctx` and not registered as an effect cannot be tracked and will not
be released — a real limit of the model, not an oversight.

```js
const interval = setInterval(pollUpstream, 60_000);
ctx.effect(() => clearInterval(interval));
```

One effect throwing does not strand the rest — `disposePluginContext` runs
every callback and returns the failures for the caller to log, rather than
stopping at the first one.

Ungated, but `assertLive`-guarded: calling it after the plugin's own
`apply()` already overran its timeout budget throws, naming the plugin.

Two things settle on their own rather than being torn down by `effect`: an
in-flight `ctx.agents.run()` keeps going after unmount (bounded by its own
`timeoutMs`, default 5 min) since disposing the process handle happens in
`runAgentSession`'s own `finally`; and an in-flight `ctx.fanout` run is
**aborted** without awaiting its handlers (a handler may be a multi-minute
agent session) — items it was mid-way through go back to `pending` for a
later `{ resume: runId }`.

## Manifest (`octomux.yml`)

```ts
interface PluginRow {
  id: string; // bare, ^[a-z0-9][a-z0-9-]*$
  name: string; // npm package name, or an absolute path
  version?: string; // exact, not a range — never checked against the installed version
  integrity?: string; // parsed as a string; NEVER VERIFIED against the tarball
  config?: Record<string, unknown>; // not read by anything in this package — see note below
  disabled?: boolean;
  grants?: PluginCapability[]; // see "Capability grants" below — absent/empty grants nothing
}
interface PluginManifest {
  plugins: PluginRow[];
}
```

Parsed and shape-checked by `server/plugins/manifest.ts` — the YAML trust
boundary. Rejected outright (whole manifest fails, zero plugins loaded, never
a boot crash):

- any top-level key other than `plugins`
- any row key other than `id`, `name`, `version`, `integrity`, `config`, `disabled`, `grants`
- `id` not matching `^[a-z0-9][a-z0-9-]*$`, or a duplicate `id`
- `name` that isn't a valid npm package name shape (scoped or unscoped) or an
  absolute filesystem path — this blocks `data:`/`http(s):`/`file:`/relative/
  traversal specifiers, which `import()` would otherwise resolve as live code
- YAML anchors/aliases anywhere in the file (`&`/`*` at a node-start
  position) — rejected before `yaml.load` even runs, as an expansion-bomb
  guard, not because anchors are unsafe in general
- a `!!tag` custom YAML tag (the parser is pinned to `yaml.JSON_SCHEMA`, which
  has no custom-tag resolvers)

`config` on a row is validated only for being a plain object if present —
nothing in `server/plugins/` reads its contents; it exists for a plugin's own
future use, not consumed by `ctx` today.

## Capability grants

A manifest row declares the `ctx` capabilities its plugin actually uses:

```yaml
plugins:
  - id: coverage-bot
    name: '@acme/octomux-coverage-bot'
    grants: [facts.define, facts.put, ui.panel]
```

### Deny by default

A row with **no `grants:` key gets nothing**. The first gated call throws,
`apply()` fails, and the row lands in `LoadReport.failed` with
`phase: 'apply'` (`assertGranted`, `server/plugins/grants.ts`). This is the
error every plugin author hits first — for example a row that omitted
`ui.panel`:

```
plugin "coverage-bot": capability "ui.panel" is not granted. Add it to the plugin's row in octomux.yml:
    grants: [ui.panel]
```

There is no warn-and-continue path — a warning nobody reads is not a
decision.

### Every capability

All 17 names in `PLUGIN_CAPABILITIES` (`server/plugins/grants.ts`, mirrors
`PluginCapability` in `@octomux/plugin-api`):

| Capability              | Gates                         | Undone on unmount?                                      |
| ----------------------- | ----------------------------- | ------------------------------------------------------- |
| `workflows.register`    | `ctx.workflows.register()`    | yes                                                     |
| `integrations.register` | `ctx.integrations.register()` | yes                                                     |
| `harnesses.register`    | `ctx.harnesses.register()`    | yes                                                     |
| `compute.register`      | `ctx.compute.register()`      | yes                                                     |
| `http.route`            | `ctx.http.route()`            | yes                                                     |
| `facts.define`          | `ctx.facts.define()`          | yes — the type definition; facts written survive        |
| `facts.put`             | `ctx.facts.put()`             | n/a — a write, not a registration                       |
| `collections.define`    | `ctx.collections.define()`    | yes — the definition; records survive                   |
| `collections.write`     | `ctx.collections.put()`       | n/a — a write, not a registration                       |
| `services.provide`      | `ctx.services.provide()`      | yes — queued provider (if any) is promoted              |
| `ui.panel`              | `ctx.ui.panel()`              | yes                                                     |
| `artifacts.write`       | `ctx.artifacts.write()`       | n/a — files land in the worktree and outlive the plugin |
| `policy.intercept`      | `ctx.policy.intercept()`      | yes                                                     |
| `secrets.read`          | `ctx.secrets.resolve()`       | n/a — a read, not a registration                        |
| `agents.run`            | `ctx.agents.run()`            | n/a — an in-flight run settles on its own               |
| `fanout.run`            | `ctx.fanout.run()`            | n/a — an in-flight run is aborted, not "undone"         |
| `surfaces.register`     | `ctx.surfaces.register()`     | yes                                                     |

### What's ungated, and why

Reads: `ctx.logger`, `ctx.settings`, `ctx.catalog.list`, `ctx.facts.read`,
`ctx.facts.watch`, `ctx.collections.query`, `ctx.collections.watch`,
`ctx.artifacts.list`, `ctx.fanout.status`/`ctx.fanout.list`, `ctx.effect()`.
None of these pick a behavior or produce a side effect worth a human's
second look — a plugin reading what's installed, what a task's facts say, or
a fan-out run's status isn't the thing capability grants exist to flag.
(`ctx.effect()` is ungated for a different reason: it registers _your own_
teardown, not a host capability.)

### Widen/approve

The acknowledged grant set per row is persisted next to the manifest, in
`plugin-grants.json` (`grantLedgerPath()`, `server/plugins/grants.ts`). A
corrupt or missing ledger is treated as an empty one — never a boot failure,
it just re-asks for acknowledgement. `resolveGrantsForRow` walks it on every
boot:

- row not in the ledger → first sight: grant everything declared, and record it
- declared ⊆ acknowledged → narrowing (or unchanged) is free
- declared ⊄ acknowledged → grant only the intersection; the newly added
  grants are **pending and withheld** until `octomux plugins approve <id>`

Why: an `npm update` that also edits `octomux.yml` must not hand a plugin
`policy.intercept` without a human deciding to allow it. Widening never takes
effect silently.

`LoadReport.grants` (what each plugin actually got this boot) and
`LoadReport.pendingGrants` (what's declared but withheld) are both keyed by
plugin id. `octomux doctor` prints both — the granted capabilities under each
loaded plugin, and a `⚠ withheld (not acknowledged)` line naming the pending
ones plus the exact `octomux plugins approve <id>` command to run.

### Not a sandbox

A plugin runs **in-process**, with the DB handle, every credential, and
`process.env` — it can do everything core can do without ever calling `ctx`.
A grant confines nothing; it's a **coordination and audit mechanism**: it
records what a plugin says it needs, enforces that claim at core's own seams,
and makes it reviewable (`octomux doctor`). `octomux plugins approve` is an
operator confirming intent, not a security check on the plugin's code.

## `LoadReport`

```ts
interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  resolvedPath: string;
  order: number;
  applyMs: number;
  reconcileMs?: number; // reconcileMs: reserved, never set today
  provides?: string[]; // same '<registry>:<qualified id>' strings as CatalogEntry.provides
}
interface LoadReport {
  loaded: LoadedPlugin[];
  failed: Array<{
    id: string;
    name: string;
    error: string;
    phase: 'resolve' | 'import' | 'apply' | 'reconcile';
  }>;
  manifestPath: string;
  safeMode: boolean;
  manifestError?: string; // set when the manifest itself failed to read/parse
  loadedAt?: string; // ISO timestamp this report was produced
  grants?: Record<string, PluginCapability[]>; // effective grants per plugin id, this boot
  pendingGrants?: Record<string, PluginCapability[]>; // declared but withheld, per plugin id
}
```

`manifestError` distinguishes "zero plugins configured" from "boot couldn't
even read the manifest." `loadedAt`, `grants`, and `pendingGrants` are all
optional only so an older persisted report — or a fixture `LoadReport`
literal — still type-checks; `octomux doctor` prints `unknown (older
report)` for a missing `loadedAt` rather than failing. `grants`/
`pendingGrants` are covered above under "Capability grants."

There is no `routeCounts` field — `provides` (SHR-268) supersedes it: a route
is just one more `route:METHOD /path` entry alongside a plugin's workflows,
harnesses, integrations, UI slots, and fact types, instead of its own
one-off counter.

`provides` is filled in at boot (`server/index.ts`, from the same
`pluginProvides()` that backs `ctx.catalog.list()`) and persisted with the
rest of the report to `~/.octomux/plugin-load-report.json`. `octomux doctor`
reads it back through `buildCatalog()` (`server/plugins/catalog.ts`) — see
README §Failure modes for what each `phase` means and when a row lands in
`failed` vs. is silently skipped (`disabled: true` rows are skipped, not
failed).

## Namespacing (`qualify()`, `server/plugins/qualify.ts`)

```ts
qualify('demo', 'changelog') === 'demo:changelog';
```

- `KIND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/` — what a **local** id (`kind`/`id`
  field you declare) and a manifest row's `id` both must match.
- `QUALIFIED_KIND_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/` — what a
  fully-qualified id looks like once octomux has namespaced it.
- Scoped package names as a plugin id sanitize to a dash: `@foo/bar` → the
  qualifier tries `foo-bar` (`sanitizePackageName`) — but in practice your
  `ctx.id` is always the manifest row's `id`, which manifest validation
  already forces through `KIND_NAME_RE`, so this only matters if you're
  calling `qualify()` yourself.
- You never see the qualified form. `ctx.id` is always your row's bare id;
  what you pass to a registrar is always your bare local `kind`/`id`.

## Not seams

Not everything core can do is a plugin seam. Something with exactly one
right implementation, or that's a pure read over state core already owns,
doesn't get a registrar — it goes straight on `ctx`, or nowhere at all.

1. **Skills and agent roles.** They ship in the bundled plugin
   (`plugin/skills/`, `plugin/agents/`) and reach launched agents via
   `--plugin-dir` — single source, there is no repo or home tier (there used
   to be one, and it never delivered anything to a running agent). Users' own
   skills/subagents live in Claude Code's native `~/.claude/skills`,
   `~/.claude/agents`, `<repo>/.claude/` — the harness reads those directly
   and octomux neither manages nor lists them. See the root `CLAUDE.md`
   §"Skills and agent roles."
2. **MCP servers.** The harness owns MCP configuration; octomux does not
   proxy or register it.
3. **Models.** A model is a per-task/per-worker value (`tasks.model`,
   `--model`, `applyModel(flags, model)`), not a registrable implementation.
   A plugin influences it through `ctx.policy` (`task.launch` /
   `harness.resume` can patch `model`), not through a registrar.
4. **History / task lifecycle.** Tasks remain the source of truth.
   `ctx.facts` is an observation log, not event sourcing — a plugin does not
   get to redefine what a task is.
5. **Artifacts.** A method on `ctx`, not a registrar (see
   [`ctx.artifacts`](#ctxartifacts) above) — nobody needs a different
   artifact implementation, they need to write one.
6. **Catalog.** Reading what is installed (`ctx.catalog.list()`) is a query,
   not an implementation choice: no `register()`, no override path.
7. **Isolation.** A git worktree per run is octomux's guarantee, not a
   preference — the public docs say so. `ctx.compute` decides only _where_
   that worktree lives, never whether one exists. It is not a pluggable
   isolation strategy.
8. **Storage.** `ctx.facts` (task-scoped, dies with the task) and
   `ctx.collections` (durable, keyed, schema-validated) are the two storage
   shapes, and neither is a registrar — a plugin does not bring its own
   storage engine. `ctx.kv` is declared on the type but **throws on every
   call today**; the storage behind it hasn't landed.

The rule that generalises all eight: a purely read-only view over state core
already owns belongs on `ctx` directly, and something that has exactly one
right implementation is not a choice worth registering.
