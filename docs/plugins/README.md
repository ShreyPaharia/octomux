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
    grants: [workflows.register] # required — see §Capability grants below
```

Capability grants are **deny-by-default**: `ctx.workflows.register` (and every
other registrar) throws for a row with no matching entry in `grants:`, so
`apply()` fails and `myplugin` never loads. The row above declares exactly
what this example's `apply()` uses; see [§Capability grants](#capability-grants)
for the full list and the widen/approve flow.

Restart octomux and check it took:

```bash
octomux start
octomux doctor
```

```
Loaded (1)
  ✓ myplugin (my-plugin-package@1.0.0) — 3.2ms
      grants: workflows.register

Failed (0)
  none
```

`octomux doctor` reads the persisted `LoadReport` from
`~/.octomux/plugin-load-report.json` — it works without a running server
(`cli/src/commands/doctor.ts`).

See [`examples/hello-plugin`](./examples/hello-plugin) for a full package
(`package.json`, a kind preset, a `README.md` showing both manifest-row
styles) verified against the real loader.

For a bigger, non-toy example — a real compute provider that runs a task's
git worktree and processes on another machine over SSH — see
[`examples/ssh-compute`](./examples/ssh-compute), covered in
[§`ctx.compute.register(p)`](#ctxcomputeregisterp) below. For a surface
plugin — a `discord` surface that renders panels to Discord markdown and
answers prompts — see [`examples/discord-surface`](./examples/discord-surface),
covered in [§`ctx.surfaces.register(surface)`](#ctxsurfacesregistersurface)
below.

## Capability grants

A manifest row declares the `ctx` capabilities its plugin uses. **Undeclared
is denied** — there is no warn-and-continue path. Try the Quickstart plugin
without the `grants:` line and `ctx.workflows.register` throws
(`assertGranted` in `server/plugins/grants.ts`), `apply()` fails, and the row
lands in `octomux doctor` under `Failed` with `phase: 'apply'`:

```
plugin "myplugin": capability "workflows.register" is not granted. Add it to the plugin's row in octomux.yml:
    grants: [workflows.register]
```

That message is the actual thrown error, verbatim — it already names the
line to add.

### The 17 capabilities

Each name is the `ctx` path it gates (`PLUGIN_CAPABILITIES` in
`server/plugins/grants.ts`, `PluginCapability` in
`packages/plugin-api/src/index.ts`):

| Capability              | Gates                         |
| ----------------------- | ----------------------------- |
| `workflows.register`    | `ctx.workflows.register()`    |
| `integrations.register` | `ctx.integrations.register()` |
| `harnesses.register`    | `ctx.harnesses.register()`    |
| `compute.register`      | `ctx.compute.register()`      |
| `http.route`            | `ctx.http.route()`            |
| `facts.define`          | `ctx.facts.define()`          |
| `facts.put`             | `ctx.facts.put()`             |
| `collections.define`    | `ctx.collections.define()`    |
| `collections.write`     | `ctx.collections.put()`       |
| `services.provide`      | `ctx.services.provide()`      |
| `ui.panel`              | `ctx.ui.panel()`              |
| `artifacts.write`       | `ctx.artifacts.write()`       |
| `policy.intercept`      | `ctx.policy.intercept()`      |
| `secrets.read`          | `ctx.secrets.resolve()`       |
| `agents.run`            | `ctx.agents.run()`            |
| `fanout.run`            | `ctx.fanout.run()`            |
| `surfaces.register`     | `ctx.surfaces.register()`     |
| `attention.ask`         | `ctx.attention.ask()`         |

Reads and logging are ungated — no grant needed for `ctx.logger`,
`ctx.settings`, `ctx.catalog.list()`, `ctx.facts.read()`/`ctx.facts.watch()`,
`ctx.collections.query()`/`ctx.collections.watch()`, `ctx.artifacts.list()`,
`ctx.fanout.status()`/`ctx.fanout.list()`, `ctx.services.require()`, or
`ctx.effect()`. (`ctx.kv`
throws regardless of grants — see [§`ctx.kv` throws today](#ctxkv-throws-today).)

### Figuring out which grants you need

Start from the `ctx.*` calls in your `apply()` — the grant name IS the `ctx`
path, so `ctx.compute.register(...)` needs `grants: [compute.register]` and
nothing else. Get it wrong and the thrown error tells you the exact line to
add; there's no need to cross-reference the table above unless you're
grant-listing up front.

### Widening a grant needs an ack

The effective set isn't just what's declared — it's checked against
`plugin-grants.json`, a ledger kept next to `octomux.yml`
(`resolveGrantsForRow` in `server/plugins/grants.ts`):

- **First time octomux sees a row** — grants everything declared, and
  records it in the ledger.
- **Removing a grant** — free, takes effect next boot, re-recorded.
- **Adding a grant** to a row octomux has already seen — withheld. The
  plugin loads with its previous (narrower) grant set; the new capability
  throws until you run `octomux plugins approve <id>`
  (`cli/src/commands/plugins.ts`). `octomux doctor` prints what's pending:

  ```
        ⚠ withheld (not acknowledged): policy.intercept — run: octomux plugins approve myplugin
  ```

This exists because an `npm update` that also rewrites `octomux.yml` must not
silently hand a plugin `policy.intercept` — widening takes a human
acknowledging it, narrowing doesn't need one.

### Grants are not a sandbox

A plugin runs in-process with the DB handle, every credential, and
`process.env`; it can do everything core can do without ever calling `ctx`.
Grants record and enforce a claim at core's own seams so a human can review
it — they confine nothing. `octomux plugins approve` is an operator
confirming intent, not a security check on the plugin's code. See
[§Limits, stated honestly](#limits-stated-honestly) for the full trust model.

## The registrars and methods on `ctx`

There are more than three now: `ctx.workflows`, `ctx.integrations`,
`ctx.harnesses`, `ctx.compute`, `ctx.surfaces`, `ctx.http`, `ctx.facts`,
`ctx.collections`, `ctx.services`, `ctx.attention`, `ctx.ui`, and `ctx.policy` are
**registrars** — each adds something to core's registries, or (only
`ctx.policy`) can refuse something core was about to do. `ctx.artifacts`,
`ctx.agents`, `ctx.fanout`, and `ctx.catalog` are **methods on `ctx`**, not
registrars — nobody needs a different artifact/agent-run/fan-out
implementation, they need to run one, so none of them has a `register()`.
`ctx.effect()`, `ctx.logger`, `ctx.settings`, and `ctx.kv` round out the
object.

| `ctx` member                                       | What it's for                                           | This guide     | Deep reference                                                                     |
| -------------------------------------------------- | ------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `ctx.workflows.register()`                         | register a workflow kind                                | §below         | [api-reference.md](./api-reference.md#ctxworkflows--ctxintegrations--ctxharnesses) |
| `ctx.integrations.register()`                      | register an integration provider                        | §below         | same                                                                               |
| `ctx.harnesses.register()`                         | register a harness                                      | §below         | same                                                                               |
| `ctx.compute.register()`                           | choose where a task's worktree/processes run            | §below         | [api-reference.md](./api-reference.md#ctxcompute)                                  |
| `ctx.surfaces.register()`                          | add a place octomux presents itself to a human          | §below         | [api-reference.md](./api-reference.md#ctxsurfaces)                                 |
| `ctx.http.route()`                                 | add an HTTP route                                       | reference only | [api-reference.md](./api-reference.md#ctxhttp)                                     |
| `ctx.facts` (`define`/`put`/`read`/`watch`)        | task-scoped notes, deleted with the task                | reference only | [api-reference.md](./api-reference.md#ctxfacts)                                    |
| `ctx.collections` (`define`/`put`/`query`/`watch`) | durable, schema'd records that outlive a task           | reference only | [api-reference.md](./api-reference.md#ctxcollections)                              |
| `ctx.services` (`provide`/`require`)               | depend on a capability by name, not a plugin package    | §below         | [api-reference.md](./api-reference.md#ctxservices)                                 |
| `ctx.ui.panel()`                                   | bind a declarative panel to a fact or collection        | reference only | [api-reference.md](./api-reference.md#ctxui)                                       |
| `ctx.policy.intercept()`                           | deny or patch a task intent at a gate point             | reference only | [api-reference.md](./api-reference.md#ctxpolicy)                                   |
| `ctx.artifacts` (`write`/`list`)                   | drop a file into the task's worktree                    | reference only | [api-reference.md](./api-reference.md#ctxartifacts)                                |
| `ctx.agents.run()`                                 | headless, structured-output agent session               | reference only | [api-reference.md](./api-reference.md#ctxagents)                                   |
| `ctx.attention.ask()`                              | ask a human a question, fanned out across surfaces      | reference only | [api-reference.md](./api-reference.md#ctxattention)                                |
| `ctx.fanout.run()`                                 | run a step per item, with retry and resume              | reference only | [api-reference.md](./api-reference.md#ctxfanout)                                   |
| `ctx.catalog.list()`                               | read what's currently installed                         | §below         | [api-reference.md](./api-reference.md#ctxcatalog)                                  |
| `ctx.settings`                                     | your plugin's own opaque config                         | §below         | [api-reference.md](./api-reference.md#ctxsettings)                                 |
| `ctx.kv`                                           | throws — plugin storage hasn't landed                   | §below         | [api-reference.md](./api-reference.md#ctxkv)                                       |
| `ctx.logger`                                       | structured logging, scoped `plugin:<id>`                | —              | [api-reference.md](./api-reference.md#ctxlogger)                                   |
| `ctx.effect()`                                     | register a teardown callback, run in reverse on unmount | reference only | [api-reference.md](./api-reference.md#plugincontext)                               |

"Reference only" rows aren't walked through step by step in this guide — the
full shape lives in `api-reference.md`. This file stays a guide: it covers
`workflows`/`integrations`/`harnesses`/`compute`/`surfaces` (the registrars
that need the most explaining), plus `catalog`/`settings`/`kv`, in depth
below.

Every registrar payload is typed as `Record<string, unknown>` at the type
level (the plan keeps `@octomux/plugin-api` free of a dependency on the
concrete server-side registry types), which means **nothing at the type
level stops you from handing back a bad payload** — the guards below
(`server/plugins/context.ts`) are the actual enforcement, and they're what
turns a bad payload into a clean `LoadReport.failed` entry instead of a boot
crash.

### `ctx.workflows.register(wf)`

| Field                                                                                      | Required?                 | Checked how                    |
| ------------------------------------------------------------------------------------------ | ------------------------- | ------------------------------ |
| `kind`                                                                                     | yes, non-empty string     | `requireLocalId`               |
| `apiRouter`                                                                                | no                        | if present, must be a function |
| `run`                                                                                      | no                        | if present, must be a function |
| everything else (`displayName`, `surfaces`, `execution`, `config`, `output`, `trigger`, …) | not validated by the host | —                              |

Full shape: `WorkflowType` in `server/workflows/types.ts`. Requires the
`workflows.register` grant — see [§Capability grants](#capability-grants).

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

| Field                         | Required?                 | Checked how                    |
| ----------------------------- | ------------------------- | ------------------------------ |
| `kind`                        | yes, non-empty string     | `requireLocalId`               |
| `validate`                    | yes                       | `requireFunctionField`         |
| `handler`                     | yes                       | `requireFunctionField`         |
| `events`                      | yes, must be an array     | `requireArrayField`            |
| `test`                        | no                        | if present, must be a function |
| `displayName`, `configSchema` | not validated by the host | —                              |

Full shape: `IntegrationProvider` in `server/integrations/types.ts`. Requires
the `integrations.register` grant — see [§Capability grants](#capability-grants).
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

An integration provider's _instance_ config (what `validate`/`handler`
receive) is set through the existing integrations API —
`POST /api/integrations` with `{ kind: "myplugin:notify", name, config }`
(`server/routes/integrations.ts`) — not through `ctx.settings` (below).

### `ctx.harnesses.register(h)`

| Field                                                                                                                                                    | Required?                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `id`                                                                                                                                                     | yes, non-empty string        |
| `newSessionId`, `buildLaunchCommand`, `buildResumeCommand`, `buildContinueCommand`, `installHooks`, `uninstallHooks`, `resolveFlags`, `validateSettings` | yes, each must be a function |

Full shape (including several **unwired** optional members —
`postLaunch`, `buildPromptDelivery`, `attachMcp`, `sendMessage` — see
`api-reference.md`): `Harness` in `server/harnesses/types.ts`. Requires the
`harnesses.register` grant — see [§Capability grants](#capability-grants).

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

## Reading what is installed — ctx.catalog

`ctx.catalog.list()` returns what's currently installed — every plugin's own
registrations, every sibling's, and core's — as one flat list, computed live
from the same registries every other `ctx.*` registrar writes into. It's a
plain read, not another registrar: there's no `register()` on it and no way to
override another entry, because "what's installed" is a query, never an
implementation choice. See [`api-reference.md#not-seams`](./api-reference.md#not-seams)
for the reasoning and [`api-reference.md`](./api-reference.md#ctxcatalog) for
the full shape.

```js
const installed = ctx.catalog.list();
ctx.logger.info({ installed: installed.map((e) => e.id) }, 'who else is here');
```

## Depending on a capability — ctx.services

`ctx.services` lets a plugin depend on "something that can send chat
messages" instead of on `octomux-plugin-slack` by name. One plugin provides
a name, another requires it, and neither imports the other:

```js
// provider (e.g. a Slack plugin)
ctx.services.provide('chat.send', {
  async send(text) {
    /* ... */
  },
});

// consumer — order in octomux.yml doesn't matter, resolution happens at mount
const chat = ctx.services.require('chat.send');
await chat.get().send('build failed');
```

Service names are the one unqualified thing in this API — `chat.send` has to
be the same string on both sides, so it isn't prefixed with a plugin id like
everything else you register. If two plugins provide the same name, the one
listed earlier in `octomux.yml` wins; the other takes over only if the first
unmounts. An unmet `require()` fails just that plugin at boot, in the load
report, never the whole boot. Full semantics, including the reload gap:
[`api-reference.md` §`ctx.services`](./api-reference.md#ctxservices).

```yaml
plugins:
  - id: slack-notify
    name: '@acme/octomux-slack-notify'
    grants: [services.provide]
```

### `ctx.compute.register(p)`

A fourth registrar, alongside the three above: it decides **where a task's
git worktree lives and where its processes run**. Not a pluggable isolation
strategy — every provider still gets a real git worktree per task, that's
octomux's guarantee, not a preference — a provider only changes which
machine that worktree (and everything touching it: `git`, tmux, the agent
process) lives on.

```js
ctx.compute.register({
  kind: 'ssh', // local id — becomes "<row-id>:ssh"
  async create(task, computeCtx) {
    /* ... make sure the repo exists on the remote, return a ComputeSession */
  },
  async resume(task, computeCtx) {
    /* optional — re-attach after a server restart; falls back to create() */
  },
});
```

Requires the `compute.register` grant — see
[§Capability grants](#capability-grants).

`create`/`resume` get a `ComputeCreateContext` with `config` (your
`settings.compute[<qualified-kind>]` blob), `secrets` (env-resolved,
handed to `create`/`resume` only — **must never reach the agent**), and
`host` (the server's own machine — `host.exec`/`host.spawnPty` is how a
remote provider spawns anything, without a new dependency). Full field-by-
field reference, including the credential invariant and why `host` exists
instead of a plugin importing `node:child_process` directly:
[`api-reference.md` §`ctx.compute`](./api-reference.md#ctxcompute).

See [`examples/ssh-compute`](./examples/ssh-compute) for a complete provider
built on exactly this — it runs a task over SSH, with a README covering
config/secrets, remote-box prerequisites, the trust model, and precisely
what its test suite verifies versus what still needs a real remote host.

### `ctx.surfaces.register(surface)`

A fifth registrar: it adds a place octomux presents itself to a human. Core
already speaks four — `web`, `cli`, `slack`, `telegram` — all frozen before
any plugin loads, same as `ctx.compute`'s `local`. This works only because
`ctx.ui` panels are declarative bindings, not components: a panel written
before your surface existed still renders on it, unchanged.

```js
ctx.surfaces.register({
  kind: 'discord', // local id — becomes "<row-id>:discord"
  renderers: ['markdown', 'json'],
  render(panel) {
    /* ... turn one resolved panel into Discord-flavoured markdown */
  },
  async prompt(ask) {
    /* optional — ask a human a question on this surface; omit it and the
       surface is read-only */
  },
});
```

The host resolves `panel.as` → `panel.renderer` against your `renderers`
list **before** calling `render` — a surface that declares
`['markdown']` only ever gets called with `renderer: 'markdown'`, never with
a renderer name it didn't declare. Unsupported degrades to your `fallback`
(default `'json'`), never drops the panel.

`prompt` is optional; without it the surface is read-only, and asking it
throws. **All four core surfaces are read-only today** — octomux's only
human-question path is the DB-backed approval gate
(`server/orchestrator/gate.ts`), untouched by this registrar — so a plugin
surface implementing `prompt` is doing something no core surface does yet.

Requires the `surfaces.register` grant — see
[§Capability grants](#capability-grants). Full field-by-field reference,
including the renderer-resolution table and the qualification/freeze rule:
[`api-reference.md` §`ctx.surfaces`](./api-reference.md#ctxsurfaces).

See [`examples/discord-surface`](./examples/discord-surface) for a complete
surface — renders panels to Discord markdown and implements `prompt`, with
its README stating plainly what would need a real Discord token/webhook to
actually post.

## Kind presets (`kinds/*.json`)

A plugin can ship declarative, schedulable kinds without writing a `run`
handler at all — a `kinds/*.json` file next to your package's entry point,
one file per kind (`spec/schedule-kinds-as-presets.md` §3,
`server/workflows/presets.ts`).

**The trap everyone hits:** the file's `kind` field must be the **bare**
local kind, and it must equal the filename stem. `kinds/changelog.json` must
declare `"kind": "changelog"` — not `"myplugin:changelog"`. Qualification
happens _after_ shape validation (`loadPluginPresetsFor` calls `qualify()`
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

| Phase       | When                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve`   | bare package name doesn't resolve under `<prefix>/node_modules`                                                                                          |
| `import`    | the module throws on import, or has no `apply` export (named or default)                                                                                 |
| `apply`     | `apply(ctx)` throws, rejects, or overruns the timeout                                                                                                    |
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
  the same way you'd treat an npm `postinstall` script. Capability grants
  (see [§Capability grants](#capability-grants)) don't change this: they gate
  the `ctx` surface only, a plugin can do everything core can do without ever
  calling `ctx`, and `octomux plugins approve` is an operator confirming
  intent, not a security check on the code.
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
