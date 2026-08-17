# Writing an octomux plugin

octomux is a **metaharness**: a plugin is an npm package listed in
`~/.octomux/octomux.yml`, whose `apply(ctx)` function runs once at boot and
registers workflow kinds, integration providers, and harnesses through `ctx`.
Everything a plugin registers is namespaced under the manifest row's own `id`,
so two plugins (or a plugin and octomux's own built-ins) can never collide.

This guide is a companion to [`api-reference.md`](./api-reference.md) (every
type and method) and [`examples/hello-plugin`](./examples/hello-plugin) (a
complete package you can copy). Every claim below is checked against the code
that enforces it — file paths are cited so you can verify anything yourself.

## Quickstart

A plugin is one file:

```js
// index.mjs
export async function apply(ctx) {
  ctx.workflows.register({
    kind: 'hello', // local id — becomes "<row-id>:hello"
    displayName: 'Hello',
    execution: 'session',
    surfaces: ['artifact'],
    trigger: { kind: 'manual' },
    run: async (runCtx) => {
      ctx.logger.info({ repoPath: runCtx.repoPath }, 'hello from my plugin');
    },
  });
}
```

`apply` can be a named export (above) or hung off a default export
(`export default { apply }`) — the loader checks both
(`server/plugins/loader.ts::pluginApply`).

Add a row to `~/.octomux/octomux.yml` (create it if it doesn't exist):

```yaml
plugins:
  - id: myplugin # local namespace — must match ^[a-z0-9][a-z0-9-]*$
    name: my-plugin-package # npm package name, or an absolute path for local dev
```

Restart octomux and check it took:

```bash
octomux start
octomux doctor
```

```
Loaded (1)
  ✓ myplugin (my-plugin-package@1.0.0) — 3.2ms

Failed (0)
  none
```

`octomux doctor` reads the persisted `LoadReport` from
`~/.octomux/plugin-load-report.json` — it works without a running server
(`cli/src/commands/doctor.ts`).

See [`examples/hello-plugin`](./examples/hello-plugin) for a full package
(`package.json`, a kind preset, a `README.md` showing both manifest-row
styles) verified against the real loader.

## The three registrars

`ctx.workflows`, `ctx.integrations`, `ctx.harnesses` are the only way a
plugin reaches core's registries — there is no other API surface
(`packages/plugin-api/src/index.ts`). Each takes a plain object typed as
`Record<string, unknown>` at the type level (the plan keeps `@octomux/plugin-api`
free of a dependency on the concrete server-side registry types), which means
**nothing at the type level stops you from handing back a bad payload** — the
guards below (`server/plugins/context.ts`) are the actual enforcement, and
they're what turns a bad payload into a clean `LoadReport.failed` entry
instead of a boot crash.

### `ctx.workflows.register(wf)`

| Field | Required? | Checked how |
|---|---|---|
| `kind` | yes, non-empty string | `requireLocalId` |
| `apiRouter` | no | if present, must be a function |
| `run` | no | if present, must be a function |
| everything else (`displayName`, `surfaces`, `execution`, `config`, `output`, `trigger`, …) | not validated by the host | — |

Full shape: `WorkflowType` in `server/workflows/types.ts`.

Your `kind` is a **local, bare id** — octomux qualifies it to
`<row-id>:<kind>` before it ever reaches the registry
(`registerPluginWorkflow` in `server/workflows/registry.ts`, called via
`qualify()` in `context.ts`). You declare `kind: 'hello'`; the id every other
part of octomux sees is `myplugin:hello`. Registering under a malformed or
already-qualified id **throws** (not warn-and-ignore) — `registerPluginWorkflow`
rejects anything that doesn't match `^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$`,
which also makes squatting a core (bare, colon-free) kind name structurally
impossible.

### `ctx.integrations.register(p)`

| Field | Required? | Checked how |
|---|---|---|
| `kind` | yes, non-empty string | `requireLocalId` |
| `validate` | yes | `requireFunctionField` |
| `handler` | yes | `requireFunctionField` |
| `events` | yes, must be an array | `requireArrayField` |
| `test` | no | if present, must be a function |
| `displayName`, `configSchema` | not validated by the host | — |

Full shape: `IntegrationProvider` in `server/integrations/types.ts`.
`events` is `HookEventName[]` — `workflow_status_changed`, `summary_updated`,
`note_added`, `ref_added`, `ref_removed`, `task_created`,
`runtime_state_changed` (`server/hook-types.ts`).

Same qualification: you declare `kind: 'notify'`, it registers as
`myplugin:notify`. Unlike workflows, a duplicate or core-colliding id here is
**warn-and-keep-first**, not a throw (`server/integrations/registry.ts`) —
though because of qualification a plugin's kind always contains a `:` and a
core kind never does, so the collision path is dead code for anything going
through `ctx.integrations.register`. It only exists in case something calls
`registerProvider` directly.

An integration provider's *instance* config (what `validate`/`handler`
receive) is set through the existing integrations API —
`POST /api/integrations` with `{ kind: "myplugin:notify", name, config }`
(`server/routes/integrations.ts`) — not through `ctx.settings` (below).

### `ctx.harnesses.register(h)`

| Field | Required? |
|---|---|
| `id` | yes, non-empty string |
| `newSessionId`, `buildLaunchCommand`, `buildResumeCommand`, `buildContinueCommand`, `installHooks`, `uninstallHooks`, `resolveFlags`, `validateSettings` | yes, each must be a function |

Full shape (including several **unwired** optional members —
`postLaunch`, `buildPromptDelivery`, `attachMcp`, `sendMessage` — see
`api-reference.md`): `Harness` in `server/harnesses/types.ts`.

That required-field list is exactly `HARNESS_REQUIRED_FN_FIELDS` in
`context.ts` — it's every member core calls unconditionally on the hot paths
(task launch, hook install/uninstall, flag resolution, settings
validate/merge). Notably **`validateAgentName` is on the `Harness` interface
but not in this required list and not called through `h.validateAgentName()`
anywhere** — every call site imports the free function from
`harnesses/types.ts` directly. Implement it if you want, but nothing calls it
on your object.

Same qualification and same warn-and-keep-first duplicate policy as
integrations (`server/harnesses/registry.ts`).

## Kind presets (`kinds/*.json`)

A plugin can ship declarative, schedulable kinds without writing a `run`
handler at all — a `kinds/*.json` file next to your package's entry point,
one file per kind (`spec/schedule-kinds-as-presets.md` §3,
`server/workflows/presets.ts`).

**The trap everyone hits:** the file's `kind` field must be the **bare**
local kind, and it must equal the filename stem. `kinds/changelog.json` must
declare `"kind": "changelog"` — not `"myplugin:changelog"`. Qualification
happens *after* shape validation (`loadPluginPresetsFor` calls `qualify()`
only once `checkPresetShape` has already passed), so a pre-qualified string
in the file is rejected outright, with a `logger.warn` + skip, never a boot
crash.

Other rules `checkPresetShape` enforces on a plugin-tier preset
(`server/workflows/presets.ts`):

- `execution` **must be `"session"`** — `"task"`/`"chat"` are rejected for
  plugin- and home-tier presets (only built-ins may use them).
- `kind` must match `^[a-z0-9][a-z0-9-]*$` (`KIND_NAME_RE`).
- `displayName` is required (non-empty string).
- `config`/`output`, if present, must be valid JSON Schema.
- `defaultCron`, if present, must be a valid 5-field cron expression.

If your plugin also registered a workflow of the same qualified kind via
`ctx.workflows.register` in `apply()`, the preset's `displayName`/`execution`/
`config`/`output` overlay onto it — your `run` handler stays.
If it didn't, octomux synthesizes a generic `session`-execution workflow
backed by the built-in session runner, using the preset's `prompt` — see
`mergePresetsIntoRegistry` in `presets.ts`.

**Where the file lives** (`pluginKindsDirFor` in `presets.ts`):

- npm package row (`name: my-plugin-package`) → `<plugin-modules-dir>/my-plugin-package/kinds/*.json`
- absolute-path dev-loop row (`name: /abs/path`) → `/abs/path/kinds/*.json` —
  note this must be the **package directory**, not the entry file. This is
  the same convention `loadPlugins()` uses for an absolute `name` when it
  resolves to a directory with a `package.json` `main` — which only works
  because octomux runs on Bun; Bun's ESM resolver accepts a directory import
  through `package.json main`, plain Node's does not.
- Only **enabled** manifest rows are scanned — an installed-but-unlisted
  package's `kinds/` directory contributes nothing, and `disabled: true`
  actually disables it.

## Settings — `ctx.settings`

```ts
const config = await ctx.settings.get(); // Record<string, unknown>, {} if unset
await ctx.settings.update({ foo: 'bar' }); // shallow-merged
```

Both are **async**. Backed by the same file as the rest of octomux's
settings (`getPluginSettings`/`updatePluginSettings` in `server/settings.ts`),
scoped under `settings.plugins.<row-id>`, shallow-merged on `update`, and
**never validated by the host** — your plugin's config is opaque to octomux,
same as an integration's own `config` blob. Reachable from outside the plugin
via `PATCH /api/settings` with `{ "plugins": { "<row-id>": { ... } } }`.

## `ctx.kv` throws today

```ts
ctx.kv.get('anything'); // throws
```

Every method — `get`, `set`, `del`, `list` — throws
`ctx.kv.<method>() is not available for plugin "<id>" — the plugin storage
task has not landed yet` (`createKv` in `context.ts`). It's on the interface
because the shape is pinned, but there's no backing store. Don't build on it;
use `ctx.settings` for opaque config, or your own storage (a file under the
repo, your own DB) if you need more.

## Failure modes

The loader (`server/plugins/loader.ts::loadPlugins`) **never throws** — every
row is isolated in its own try/catch, and a bad plugin becomes a
`LoadReport.failed` entry, not a broken boot:

| Phase | When |
|---|---|
| `resolve` | bare package name doesn't resolve under `<prefix>/node_modules` |
| `import` | the module throws on import, or has no `apply` export (named or default) |
| `apply` | `apply(ctx)` throws, rejects, or overruns the timeout |
| `reconcile` | reserved — `reconcile()` is on the `OctomuxPlugin` interface but the loader **does not call it yet**. There is no `reconcile` failure today; see Limits. |

Both the `import()` and the `apply()` call get a **10 second** default timeout
(`DEFAULT_APPLY_TIMEOUT_MS` in `loader.ts`; `withTimeout` races each, not
configurable from the manifest or a CLI flag today). On timeout the plugin is
recorded as `failed` with the matching phase.

Note what the timeout does and doesn't do. `apply()` itself is **never
cancelled** — there's no `AbortSignal` on `PluginContext`. What stops a
late-finishing plugin from taking effect is revocation: the loader calls
`revokePluginContext(ctx)` in its `apply()` catch, after which every registrar
on that context throws. So a plugin that overruns and then resolves in the
background cannot register anything — its report and the live registries agree.

Keep `apply()` fast anyway. Registration is the only thing revocation protects;
anything else your `apply()` set in motion keeps running.

A manifest that's missing is `{ plugins: [] }` (fine, fresh install). A
manifest that exists but fails to parse — bad YAML, an unknown top-level key,
a row that fails `id`/`name`/`version`/`integrity`/`config`/`disabled` shape
checks, YAML anchors/aliases (rejected outright, no legitimate use here and a
known expansion-bomb vector) — is a `logger.warn` and **zero plugins loaded**,
never a boot crash (`server/plugins/manifest.ts`).

`--safe-mode` (`OCTOMUX_SAFE_MODE=1`, wired in `bin/main.js`) skips **every**
plugin row — there's no per-plugin opt-out, only all-or-nothing. Core
harnesses/providers are unaffected.

## Limits, stated honestly

- **No sandbox.** A plugin's `apply()` (and any `run`/`handler`/`validate`
  it registers) executes **in-process**, with full Node/Bun privileges —
  filesystem, network, `child_process`, everything. Treat every manifest row
  the same way you'd treat an npm `postinstall` script.
- **`reconcile()` is declared, not called.** `OctomuxPlugin.reconcile?(ctx)`
  exists on the interface (`packages/plugin-api/src/index.ts`) for plugins
  owning out-of-process state (worktrees, tmux, files in a repo), and the
  loader's own doc comment says it runs "after `recoverTasks()`" in a later
  wave — but no call site invokes it yet. Don't rely on it running.
- **`integrity` is parsed, not verified.** `manifest.ts` accepts an
  `integrity` string on a row (typed as a string, nothing more) and never
  checks it against the resolved package. A mismatched or missing hash
  doesn't block a load.
- **Safe mode is all-or-nothing.** `--safe-mode` disables every plugin row;
  there's no way to disable just one from the CLI flag (use
  `octomux plugins disable <id>` against the manifest instead —
  `cli/src/commands/plugins.ts`).
