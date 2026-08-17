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
}
```

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

Persisted to `~/.octomux/plugin-load-report.json` after every boot
(`server/index.ts`), read by `octomux doctor` — see README §Failure modes for
what each `phase` means and when a row lands in `failed` vs. is silently
skipped (`disabled: true` rows are skipped, not failed).

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
