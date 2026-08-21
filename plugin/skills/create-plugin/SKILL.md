---
name: create-plugin
description: Use when authoring a new octomux plugin package — package layout, the apply(ctx) export, choosing a registrar, shipping kind presets, testing locally, and confirming with octomux doctor.
---

# Create an octomux plugin

Author a plugin package that registers into octomux at boot: a workflow kind, an
integration provider, or a harness. A plugin is a normal npm package that exports
an `apply(ctx)` function; octomux loads it in-process via `import()` — see the
`add-plugin` skill for the trust implications of that before you ship one.

## Package layout

```
octomux-plugin-<name>/
  package.json       # name, version, type: module, main (or exports)
  index.js           # the apply(ctx) export
  kinds/              # optional — schedule-kind presets this plugin ships
    <kind>.json
```

`package.json` needs a real `main`/`exports` field once published — during local
dev (see "Testing it locally" below) a bare `index.js` with no `package.json` also
resolves, because Node's module resolution falls back to `index.js` when no
`package.json` is present. Don't rely on that for anything you publish.

## The `apply(ctx)` export

```js
export function apply(ctx) {
  ctx.logger.info({}, 'plugin applied');
  ctx.workflows.register({ kind: 'changelog', displayName: 'Changelog', surfaces: ['feed'] });
}
```

`apply` can also hang off a default export (`export default { apply }`) — both
forms are read as "this module is the plugin."

`apply(ctx)` runs once at boot, in manifest order, each in its own try/catch — one
plugin throwing never takes down another. It has a 10-second budget
(`DEFAULT_APPLY_TIMEOUT_MS` in `server/plugins/loader.ts`); overrun it and the
loader marks the plugin `failed` (phase `apply`) and **revokes** its context — any
registrar call your `apply()` makes after that point throws `context revoked —
… refused because apply() overran its timeout budget` instead of quietly landing
in the live registry after the loader already reported you failed. Keep `apply()`
synchronous-fast; don't do network calls or slow I/O in it.

An optional `reconcile?(ctx)` export exists on the `OctomuxPlugin` interface for
plugins owning out-of-process state (worktrees, tmux, files written into a repo)
and is documented as **required** for that case — but nothing in the codebase
calls it yet (`server/plugins/loader.ts` explicitly does not; boot has no other
caller). Export it if your plugin owns that kind of state so you're ready when the
wiring lands, but don't depend on it running today. `apply()` is currently the
only place your plugin's own code executes at boot.

## `ctx` — what you get

| Member             | Shape                                                                | Notes                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.id`           | `string`                                                             | your manifest row's bare `id`, e.g. `"demo"`                                                                                          |
| `ctx.logger`       | `{debug,info,warn,error}(obj, msg?)`                                 | structured logger, prefixed `plugin:<id>`                                                                                             |
| `ctx.settings`     | `{get(), update(patch)}` — both **async**                            | your own opaque blob under `settings.json`'s `plugins.<id>`; never schema-checked                                                     |
| `ctx.kv`           | `{get,set,del,list}`                                                 | **every method throws today** — `ctx.kv.<method>() is not available … plugin storage task has not landed yet`. Don't build on it yet. |
| `ctx.workflows`    | `{register(wf)}`                                                     | see below                                                                                                                             |
| `ctx.integrations` | `{register(p)}`                                                      | see below                                                                                                                             |
| `ctx.harnesses`    | `{register(h)}`                                                      | see below                                                                                                                             |
| `ctx.http`         | `{route(method, path, handler)}`                                     | serves at `/api/p/<id><path>`; handler gets `{params, query, body, headers}` / `{status, json}`, not express objects                  |
| `ctx.facts`        | `{define,put,read,watch}`                                            | task-scoped append-only observation log; your types are qualified `<id>:<type>`                                                       |
| `ctx.ui`           | `{panel(binding)}`                                                   | declarative binding onto a fact type — never a component; the client owns every renderer                                              |
| `ctx.artifacts`    | `{write(taskId, {name, mime, body}), list(taskId)}` — both **async** | files your run produced. NOT a registrar — see below                                                                                  |
| `ctx.effect`       | `(dispose) => void`                                                  | teardown callback, run in reverse registration order when your plugin unmounts                                                        |

## `ctx.artifacts` — writing output

A plugin that produces a file (a review report, a coverage summary, a generated
diagram) writes it here:

```js
await ctx.artifacts.write(taskId, {
  name: 'coverage.md', // bare filename, [A-Za-z0-9][A-Za-z0-9._-]{0,127}
  mime: 'text/markdown',
  body: '# Coverage\n\n92%\n',
});
```

- It lands at `<worktree>/.octomux/artifacts/<your-id>/<name>` — inside the task's
  git worktree, so it diffs and survives a DB wipe.
- The `<your-id>` segment is always your manifest row id. You cannot write into
  another plugin's namespace, and two plugins can both write `report.md`.
- It shows up in the run detail view automatically. You register nothing to make
  that happen.
- `list(taskId)` returns EVERY plugin's artifacts on that task, not just yours —
  same unscoped read as `ctx.facts.read`.
- `write()` **rejects** if the task has no worktree yet, or if `name`/`mime` fail
  validation, or the body is over 5 MB. It is not fire-and-forget: await it.
- Artifacts are files, so they outlive your plugin — unmounting does not delete
  them. They die with the task.

This is a method on `ctx`, not a registrar. There is no `ctx.artifacts.register()`
and there will not be: nobody needs a different artifact implementation.

## Choosing a registrar

| Registrar      | Use when your plugin…                                                     | Local id field |
| -------------- | ------------------------------------------------------------------------- | -------------- |
| `workflows`    | adds a new schedule/task kind (cron trigger, run feed, detail view)       | `kind`         |
| `integrations` | adds a webhook/provider handler (like Jira, Linear, Slack)                | `kind`         |
| `harnesses`    | adds a new coding-agent CLI octomux can launch (like Claude Code, Cursor) | `id`           |

Every payload you hand a registrar is `Record<string, unknown>` at the type level
(`@octomux/plugin-api` keeps the concrete server-side shapes out of the
types-only package) — but `server/plugins/context.ts` guards the fields core
actually dereferences unconditionally, and **throws synchronously inside your
`apply()`** if they're missing or the wrong type, so a bad payload surfaces as a
load-report `failed` row instead of a boot crash somewhere downstream:

- **`workflows.register(wf)`** — requires a non-empty string `kind`. If present,
  `apiRouter` and `run` must be functions (an Express `Router` is itself callable,
  so that's a router instance, not a factory).
- **`integrations.register(p)`** — requires a non-empty string `kind`, and
  function fields `validate` and `handler`; `events` must be an array. `test`, if
  present, must be a function.
- **`harnesses.register(h)`** — requires a non-empty string `id`, and ALL of
  these must be functions: `newSessionId`, `buildLaunchCommand`,
  `buildResumeCommand`, `buildContinueCommand`, `installHooks`, `uninstallHooks`,
  `resolveFlags`, `validateSettings`. A harness missing even one of these fails
  registration immediately — not silently at the first task launch that needs it.
  See the `configure-harness` skill for which `Harness` members are still unwired
  even once registration succeeds.

## Capability grants — declare or your plugin won't load

Every registrar call in `apply()` is gated by a capability the manifest row must
declare in `grants:`. Undeclared is **denied**, not warned: the registrar throws
synchronously, `apply()` fails, and your row lands in the load report as a
`phase: 'apply'` failure naming the plugin and the missing capability. There is
no partial-load path — if `ctx.policy.intercept()` throws, none of your other
registrar calls that ran before it are undone, but the plugin as a whole is
marked failed.

| Capability              | Gates                         | Local id field / method |
| ----------------------- | ----------------------------- | ----------------------- |
| `workflows.register`    | `ctx.workflows.register()`    | `kind`                  |
| `integrations.register` | `ctx.integrations.register()` | `kind`                  |
| `harnesses.register`    | `ctx.harnesses.register()`    | `id`                    |
| `compute.register`      | `ctx.compute.register()`      | `kind`                  |
| `http.route`            | `ctx.http.route()`            | —                       |
| `facts.define`          | `ctx.facts.define()`          | `type`                  |
| `facts.put`             | `ctx.facts.put()`             | —                       |
| `ui.panel`              | `ctx.ui.panel()`              | —                       |
| `artifacts.write`       | `ctx.artifacts.write()`       | —                       |
| `policy.intercept`      | `ctx.policy.intercept()`      | —                       |
| `fanout.run`            | `ctx.fanout.run()`            | `name`                  |

Reads are ungated — `ctx.facts.read`/`.watch`, `ctx.artifacts.list`,
`ctx.fanout.status`/`.list`, `ctx.catalog.list`, `ctx.settings`, `ctx.logger`,
`ctx.effect` need no grant. Declare only what you call:

```yaml
plugins:
  - id: spendcap
    name: octomux-plugin-spendcap
    grants: [policy.intercept, facts.put]
```

Widening an installed plugin's grants later (e.g. a new version starts calling
`facts.define`) does **not** take effect on the operator's next boot just
because your published manifest snippet says so — the operator's own
`plugin-grants.json` ledger has to catch up via `octomux plugins approve <id>`.
Document any new grant your release adds in your changelog; an operator who
skips the approve step gets your call denied, not a silent no-op.

## `ctx.policy` — refusing or patching an intent

`ctx.policy.intercept(point, hook)` is the one registrar that can say no. It
needs the `policy.intercept` grant. Four points: `task.launch`,
`harness.resume`, `review.publish`, `integration.send`. Your hook gets a
`PolicyIntent` (`point`, optional `taskId`/`repoPath`, and point-specific
`data`) and returns one of `{ deny: string }`, `{ patch: {...} }`, or nothing
(no opinion — pass through).

Two shapes worth knowing:

```js
// A spend cap denying task.launch past a budget.
ctx.policy.intercept('task.launch', async (intent) => {
  if (await overBudget(intent.repoPath)) {
    return { deny: 'monthly spend cap reached for this repo' };
  }
});

// A router patching the model for a specific harness.
ctx.policy.intercept('task.launch', (intent) => {
  if (intent.data.harnessId === 'cursor') {
    return { patch: { model: 'gpt-5.1-codex' } };
  }
});
```

Only `model` (`task.launch`, `harness.resume`), `verdict` (`review.publish`), and
`payload` (`integration.send`) are patchable — a patch key a call site doesn't
list is ignored, core decides what it honours. Hooks for a point run in
registration order; the first `deny` short-circuits and later hooks never run;
a `patch` merges into `intent.data` so the next hook sees your patched values.

**Fail open, on purpose.** A hook that throws, or runs past the host's timeout
(5s), is logged and treated as "no opinion" — it does not block the intent.
Write your hook assuming a crash costs you an audit log line, not an outage:
if being unable to reach an external spend-tracking API should be a hard stop,
you have to encode that yourself (e.g. deny when the budget check can't be
reached), because a thrown error from that same check fails open instead.

**What gets recorded.** A deny or patch on a task-scoped intent (one with a
`taskId`) is written twice: a `core:policy.decision` fact (readable via
`ctx.facts.read`/`.watch` by any plugin) and a `task_updates` row of kind
`policy` that shows in the task's Activity panel. An intent without a `taskId`
is logged but not recorded as a fact.

This is not containment — see `add-plugin` for why a `policy` deny doesn't stop
a plugin's own code from doing whatever it wants outside `ctx`.

## Local vs. qualified ids

You always declare a **local, bare** id (`kind: 'changelog'`, `id: 'my-harness'`) —
never the qualified form. The host qualifies it for you: `qualify(pluginId,
localId)` → `"<sanitized-plugin-id>:<local-id>"`, e.g. `demo:changelog`. Your
manifest row's own `id` (not your npm package `name`) is the qualifying prefix; a
scoped package name like `@foo/bar` sanitizes to `foo-bar` if you ever pass a raw
package name through `qualify` directly, but in practice you'll only ever supply
the local half — the host does the rest. Both halves must match
`^[a-z0-9][a-z0-9-]*$` (`KIND_NAME_RE`, `server/plugins/qualify.ts`) — no
uppercase, no `..`, no path separators.

## Shipping `kinds/*.json` presets

A workflow-registering plugin can also ship ready-made schedule-kind presets
without writing any loader code — `server/workflows/presets.ts` scans
`<pkg>/kinds/*.json` for every enabled manifest row automatically:

```
octomux-plugin-demo/
  kinds/
    changelog.json     # "kind": "changelog" — must match the filename stem
```

The file's `"kind"` field must equal its filename stem (`changelog.json` →
`"kind": "changelog"`) — the loader validates that _before_ qualifying it to
`demo:changelog`. You never write the package/plugin id into the file yourself.
Presets load in order built-in → plugin → home, and a home-tier preset with the
same qualified kind always wins (moot here, since a qualified kind can never
collide with a built-in).

## Testing it locally

Point octomux at a scratch install root so you're not touching `~/.octomux`, and
have it resolve your plugin from a real `node_modules` layout under that root
(this is exactly what a real install looks like, just off `OCTOMUX_PLUGIN_PREFIX`
instead of the default `octomuxRoot()`):

```bash
export OCTOMUX_PLUGIN_PREFIX=/tmp/octomux-plugin-dev
export OCTOMUX_DATA_DIR=/tmp/octomux-plugin-dev/data
mkdir -p "$OCTOMUX_PLUGIN_PREFIX/node_modules/octomux-plugin-demo"
# symlink or copy your package build into that node_modules entry
```

Write the manifest that references it:

```yaml
# $OCTOMUX_DATA_DIR/octomux.yml
plugins:
  - id: demo
    name: octomux-plugin-demo
    version: 1.0.0
```

Start octomux against that root and watch the boot log for your `apply()` logger
call, then confirm with `doctor`:

```bash
octomux start
octomux doctor
```

`doctor` reads the persisted load report — it works even if boot never fully came
up, which is exactly the case you need it for when iterating on a plugin that's
breaking something. A clean load shows your plugin under `Loaded (N)` with its
`applyMs`; a broken one shows under `Failed (N)` with the phase (`resolve`,
`import`, or `apply`) and the exact thrown message.

## Notes

- An absolute local path also works as a manifest row's `name` (instead of an npm
  package name) — useful for point-in-place iteration without touching
  `node_modules` at all; `manifest.ts` accepts either form.
- Collision handling differs per registrar: `harnesses.register` and
  `integrations.register` warn-and-keep-first on a duplicate id, and refuse a
  plugin id that squats a core harness id (`claude-code`, `cursor`) or core
  provider kind (`jira`, `linear`, `slack-gateway`, `telegram-gateway`) once
  those freeze at boot. `workflows.register` is stricter: it throws synchronously
  if your qualified kind isn't actually qualified (`<pkg>:<local>` — this also
  catches any attempt to squat a bare core kind name, since core kinds never
  contain `:`), so a workflow-registration mistake fails your `apply()` outright
  instead of silently losing to core.
- See `add-plugin` for the install/manifest-row workflow and the trust model, and
  `configure-harness` for what a registered harness's members actually do once
  loaded.
