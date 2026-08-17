---
name: configure-harness
description: Use when configuring which coding-agent harness octomux launches — per-task --model, harness selection, settings.harnesses.<id>, resolveFlags/validateSettings, and registering an additional harness via a plugin.
---

# Configure the harness octomux launches

octomux launches a **harness** (a coding-agent CLI) per task/agent. Two ship
built-in — `claude-code` (default) and `cursor` — and a plugin can register more.
This skill covers picking one, tuning its flags, and what's still unwired if
you're building against the `Harness` interface directly.

## Per-task model override

The narrowest lever: override the model for one task or one agent, independent of
harness settings.

```bash
octomux create-task --model claude-opus-4-8 ...
octomux add-agent --task <task-id> --model claude-sonnet-4-6 --prompt '...'
```

`applyModel(flags, model)` (`server/harnesses/shared.ts`) strips any existing
`--model <value>` out of the resolved flags string and appends the per-task one —
so a global `--model` in `settings.harnesses.claude-code.flags` never wins over a
task's own override.

## Harness selection

Per-task, at creation time:

```bash
octomux create-task --harness-id cursor ...
```

Omit `--harness-id` over the CLI/API and `task.create` hardcodes the literal
`'claude-code'` (`server/registry/capabilities/task.ts`) — this does **not**
consult `settings.defaultHarnessId`. `settings.defaultHarnessId` only drives the
**dashboard's** create-task dialog: `HarnessPicker.tsx` reads it client-side to
pre-select a value in the dropdown before the user ever submits, so it's a UI
convenience, not a server-side default. Set it from the Settings page in the
dashboard, or:

```bash
curl -X PATCH http://127.0.0.1:7777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"defaultHarnessId": "cursor"}'
```

There's no CLI wrapper for `/api/settings` — use `curl` against the running
server, or the Settings page in the dashboard. If you want every task to actually
launch on a non-`claude-code` harness regardless of client, pass `--harness-id`
explicitly every time (or wrap `create-task` in your own script/alias) — there is
currently no server-side knob for that. `getHarness(id)` throws `Unknown harness:
<id>` if nothing registered that id, so a typo in `--harness-id` surfaces
immediately at task-launch time.

## `settings.harnesses.<id>` and `validateSettings`

Per-harness settings live under `harnesses.<id>` in `settings.json`, keyed by
harness id. Write them with a `PATCH /api/settings`:

```bash
curl -X PATCH http://127.0.0.1:7777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"harnesses":{"claude-code":{"flags":"--verbose","dangerouslySkipPermissions":false}}}'
```

Every write to a **registered** harness id runs through that harness's own
`validateSettings(blob)` before it's persisted — an unrecognized field, wrong
type, or (for `claude-code`'s `flags`) a shell metacharacter is rejected with a
400, not silently dropped or stored broken:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH http://127.0.0.1:7777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"harnesses":{"claude-code":{"flags":"--foo; rm -rf /"}}}'
# 400 — "Invalid harnesses.claude-code.flags: contains forbidden shell metacharacter …"
```

A blob for an **unregistered** harness id (e.g. a plugin harness that isn't
currently loaded) is preserved verbatim, unvalidated, so config for a temporarily-
disabled plugin harness survives round-trips instead of getting silently dropped.

`GET /api/settings` also folds in `OCTOMUX_CLAUDE_FLAGS` — if that env var is set,
`claude-code`'s `resolveFlags()` uses it and ignores the stored `flags` blob
entirely (env always wins over settings.json).

## `resolveFlags`

Each harness computes its own launch-time flags string from `OctomuxSettings`:

```ts
resolveFlags(settings: OctomuxSettings): string
```

For `claude-code`: `OCTOMUX_CLAUDE_FLAGS` env (if set) wins outright; otherwise
`--dangerously-skip-permissions` (if the setting is true) plus the validated
`flags` string, both from `settings.harnesses['claude-code']`. This is what feeds
into `buildLaunchCommand`/`buildResumeCommand`/`buildContinueCommand` alongside
the per-task `--model`.

## Registering an additional harness from a plugin

```js
ctx.harnesses.register({
  id: 'my-harness',
  displayName: 'My Harness',
  sessionIdMode: 'orchestrator-assigned', // or 'harness-issued'
  newSessionId() {
    /* ... */
  },
  buildLaunchCommand(opts) {
    /* ... */
  },
  buildResumeCommand(opts) {
    /* ... */
  },
  buildContinueCommand(opts) {
    /* ... */
  },
  async installHooks(worktreePath, baseUrl, hookToken) {
    /* ... */
  },
  async uninstallHooks(dirPath) {
    /* ... */
  },
  resolveFlags(settings) {
    /* ... */
  },
  validateSettings(blob) {
    /* ... */
  },
  validateAgentName(name) {
    /* ... */
  },
});
```

All eight functions above are checked as required at registration time (see the
`create-plugin` skill's registrar-guard table) — a harness missing one fails to
register at all, loudly, in the plugin load report. The id you pass is your
**local** id; octomux qualifies it to `<your-plugin-id>:my-harness` the same way
it qualifies a workflow kind. Core ids `claude-code` and `cursor`
(`CORE_HARNESS_IDS`) can never be redefined by a plugin.

## Members declared but not yet wired

The `Harness` interface (`server/harnesses/types.ts`) has five members with no
call site reading them yet — implement them if you want, but nothing in core
calls them today:

| Member                  | Intent (per its doc comment)                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `supportsClaudePlugins` | Purely descriptive flag for Claude Code's plugin ecosystem support.                                        |
| `buildPromptDelivery`   | Would replace the hardcoded prompt-file-append logic in `task-engine/launch.ts::buildAgentStartupCommand`. |
| `attachMcp`             | Would replace the hardcoded MCP config wiring in `task-engine/launch.ts::applyOrchestratorMcpConfig`.      |
| `sendMessage`           | Would replace the harness-specific message-send path, currently hardcoded per-harness in the task engine.  |
| `detectActivity`        | Would replace the hardcoded idle/active detection, currently hardcoded in the task engine.                 |

Be honest with yourself about this when writing a plugin harness: don't implement
these expecting them to run — they're reserved interface surface for a future
wave, not dead weight you can safely skip either, since a call site could start
reading them without warning once that wave lands.

## Notes

- `octomux create-task --harness-id`, `octomux add-agent --model`: both verified
  against the CLI's own `--help` output — flag names come straight from the zod
  schema (`harness_id` → `--harness-id`), so if the schema changes so does the
  flag.
- The `add-plugin` skill covers installing a harness-shipping plugin in the first
  place; this skill only covers configuring what's already registered.
