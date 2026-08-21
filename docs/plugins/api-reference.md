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
  readonly id: string; // this row's bare manifest id
  readonly logger: PluginLogger;
  readonly settings: PluginSettingsScope;
  readonly kv: PluginKv;
  readonly workflows: WorkflowRegistrar;
  readonly integrations: IntegrationRegistrar;
  readonly harnesses: HarnessRegistrar;
  readonly http: HttpRegistrar;
  readonly facts: FactsRegistrar;
  readonly ui: UiRegistrar;
  readonly catalog: CatalogReader;
  effect(dispose: () => void | Promise<void>): void;
  readonly compute: ComputeRegistrar;
  readonly agents: AgentRunner;
}
```

`http`, `facts`, `ui`, and `effect` aren't documented here yet — that's other
tickets' debt. `catalog` is below.

One context is built per manifest row (`createPluginContext(row.id)` in
`context.ts`) and handed only to that row's `apply()`/`reconcile()`.

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

## Manifest (`octomux.yml`)

```ts
interface PluginRow {
  id: string; // bare, ^[a-z0-9][a-z0-9-]*$
  name: string; // npm package name, or an absolute path
  version?: string; // exact, not a range — never checked against the installed version
  integrity?: string; // parsed as a string; NEVER VERIFIED against the tarball
  config?: Record<string, unknown>; // not read by anything in this package — see note below
  disabled?: boolean;
}
interface PluginManifest {
  plugins: PluginRow[];
}
```

Parsed and shape-checked by `server/plugins/manifest.ts` — the YAML trust
boundary. Rejected outright (whole manifest fails, zero plugins loaded, never
a boot crash):

- any top-level key other than `plugins`
- any row key other than `id`, `name`, `version`, `integrity`, `config`, `disabled`
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
}
```

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

Reading what is installed is a query, not an implementation choice — it
never picks a behavior, so it doesn't get a registrar. `ctx.catalog` is the
worked example: it's a plain read-only method on `ctx`, not
`ctx.catalog.register()`, and there's no override path either. The same
reasoning applies to anything else added later that is purely a read over
state core already owns — it belongs on `ctx` directly, not behind a new
registrar.
