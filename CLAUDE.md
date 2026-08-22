# octomux

npm package (`octomux`) for orchestrating autonomous Claude Code and Cursor agents from a
web dashboard. Single binary: `octomux <command>`. Data stored at `~/.octomux/` in
production, `./data/` in development (`NODE_ENV !== 'production'`); override the production
root with `OCTOMUX_DATA_DIR` (the Electron app sets this to an app-private path).

## Tech Stack

- **Frontend:** Vite + React 19 + Tailwind CSS 4 + shadcn/ui + React Router 7
- **Backend:** Express 5 + `bun:sqlite` (WAL mode) + `Bun.Terminal` + ws
- **Terminal:** xterm.js (bidirectional) → `Bun.Terminal` (`server/pty.ts`) → `tmux attach`
- **Isolation:** git worktrees per task, tmux sessions per task, tmux windows per agent
- **IDs:** nanoid(12)
- **Runtime:** bun everywhere — package manager, script runner, dev server, test runner,
  and the compiler for the shipped binary. No Node in the build or at runtime.
  There is no better-sqlite3, node-pty, vitest, or tsup; do not reintroduce them.
- **Binary:** `bun build --compile bin/main.js` → one self-contained executable per
  platform. `start` launches the dashboard, all other subcommands are CLI operations.

## Commands

- `bun run dev` — starts Express (7777) + Vite concurrently
- `bun run test` — all three suites below
- `bun run test:server` — `server/` + `cli/review` (bun test)
- `bun run test:client` — `src/` (bun test + happy-dom preload)
- `bun run test:units` — `cli/src`, `packages`, `bin` (bun test)
- `bun run test:watch` — bun test in watch mode (server suite)
- `bun run test:e2e` — Playwright E2E tests (auto-starts servers)
- `bun run test:e2e:ui` — Playwright interactive UI mode
- `bun run bench:task-create [-- --repo <path> --runs N]` — times real `startTask`
  runs and prints a per-stage breakdown (reads the `stage_timing` log lines)
- `bun run lint` / `bun run lint:fix` — ESLint 9 flat config
- `bun run format` / `bun run format:check` — Prettier
- `bun run typecheck` — `tsc -b` (project references across `packages/*`)
- `bun run build` — builds `packages/*` (diff-engine, types, test-fixtures, api-client,
  capabilities), then the compiled binary
- `bun run build:binary` — this host only → `dist-bin/octomux`
- `bun run build:binary:all` — all six targets
- `bun run build:npm` — build all + sign + stage `dist-npm/` for publishing

## Architecture

- `server/` — Express backend (API, terminal streaming, task lifecycle, DB)
  - `api.ts` — mounts the routers from `routes/` onto the Express app
  - `routes/` — one router per surface (tasks, task-agents, task-workflow, diffs, comments,
    chats, loops, skills, schedules, kinds, settings, orchestrator, …). Workflow-owned
    routers (`loops`, plus `reviews` and `pr-extracts` under `server/workflows/*/routes.ts`)
    are mounted via each workflow's `apiRouter`, not imported by `api.ts` directly.
  - `app.ts` — extracted `createApp()` for testability
  - `task-engine/` — worktree + tmux + harness lifecycle. `cleanup.ts` holds `closeTask` /
    `deleteTask`; also `launch.ts`, `git.ts`, `sessions.ts`, `terminals.ts`, `reconcile.ts`,
    plus `lifecycle/`, `setup/`, `loop/` subdirs.
  - `db.ts` — SQLite singleton with `getDb()` / `setDb()` / `initDb()`
  - `logger.ts` — pino root + `childLogger('<module>')` helper
  - `types.ts` — re-exports `@octomux/types` (Task, Worker, RuntimeState, WorkflowStatus,
    WorkerStatus) plus the server-only review/orchestrator types
  - `harnesses/` — pluggable harness implementations (`claude-code.ts`, `cursor.ts`;
    `claude-code` is the default via `DEFAULT_HARNESS_ID`).
    Each `Harness` exports `id`, `displayName`, `sessionIdMode`, command builders,
    `installHooks`, `syncAgents`, `resolveFlags`, `validateSettings`. Spec at
    `spec/harness-abstraction.md`; step plan at `plans/2026-05-08-harness-abstraction-step-1.md`.
  - `hook-base-url.ts` — `hookBaseUrl()` returns `http://127.0.0.1:<port>` for harness callbacks.
  - `schedules/cron.ts` — `isCronDue()`, the 5-field cron evaluator (`croner`, UTC) behind
    scheduled runs. Rows live in the `schedules` table; `poller/schedule-cron.ts` fires them.
  - `orchestrator/` — the conductor: command gate/schemas, MCP server, approval timeouts.
  - `gateway/` — chat-DM front end onto the conductor (Telegram + Slack), default-deny
    owner allowlist, opt-in per channel. Setup and security model in `server/gateway/README.md`.
  - `integrations/` — provider registry + credential store (`jira`, `linear`,
    `slack-gateway`, `telegram-gateway`); env vars win over DB-stored values.
- `src/` — React SPA (pages, components, lib/api.ts)
  - `workflows/` — front-end workflow-UI registry mirroring `server/workflows/`.
    `registerWorkflowUI(kind, { navLabel, icon, ListView, DetailView })` (`loops/register.tsx`)
    backs the generic `/w/:kind/:id` route; a kind that registers `getItem` + `outputSchema`
    instead of a `DetailView` falls back to the schema-driven `DefaultDetailView`.
- `cli/` — CLI tool. `task` commands (list/get/create/start/move/delete) are generated from
  `@octomux/capabilities`' zod schemas (`registerCapabilityCommands`, `cli/src/index.ts`), so
  they can't drift from server-side validation; everything else is one file per subcommand in
  `cli/src/commands/` (close-task, resume-task, add-agent, send-message, stop-agent, init,
  emit, loop-start, loop-start-group, learn/recall/unlearn, post-review, task-updates,
  task-ref-add/rm, list-skills/get-skill, files, plugins, doctor, …). `task-move`/`task-note`
  were retired with the `/note` route — narrative now lives in the task's
  `.octomux/artifact.md`, no CLI write surface for `task-move`/`task-note`. `task-summary` is
  back as the generated `task summary` capability command (alias `task-summary`), writing the
  artifact's Summary section.
- `packages/` — bun workspaces: `types`, `diff-engine`, `api-client`, `test-fixtures`, plus
  the prebuilt `tmux-{darwin,linux}-{arm64,x64}` binaries
- `electron/` — macOS desktop app wrapper (`build:electron` / `dist:electron`)
- `e2e/` — Playwright E2E tests

DB migrations are forward-only. Back up `~/.octomux/data/tasks.db` (prod) or
`./data/tasks.db` (dev) before upgrading across either of these:

- **harness abstraction** — renames `workers.claude_session_id` → `harness_session_id`,
  adds `tasks.harness_id` / `workers.harness_id` / `workers.hook_token`, relaxes
  `permission_prompts.session_id` to nullable.
- **agents/workers rename** — `agents` → `workers` (per-task tmux worker) and
  `agent_configs` → `agents` (persistent conductor agent), in that mandatory order.
  Runs in `renameAgentWorkerTables()` **before** `SCHEMA` executes in `initDb()`, or
  `CREATE TABLE IF NOT EXISTS workers` would create an empty placeholder ahead of the
  rename and orphan every worker row. SQLite rewrites dependent `REFERENCES` clauses
  automatically (`legacy_alter_table = 0`).

## Logging

- All server-side logs go through `server/logger.ts` (pino). Use
  `const logger = childLogger('<module>');` at the top of each `server/` file and
  emit structured events — `logger.info({ task_id, operation, ... }, 'message')`.
  Never use `console.*` in `server/`.
- Every task/agent lifecycle log line must include `task_id` (and `agent_id`
  where relevant) so grep can reconstruct a timeline:
  `grep '"task_id":"<id>"' ~/.octomux/logs/octomux.log`.
- Output: dev = pretty stdout + rotated JSON at `./data/logs/octomux.log`,
  prod = rotated JSON at `~/.octomux/logs/octomux.log`, test = silent.
- Rotation: daily or 10MB, 7 files kept (pino-roll).
- Default level: `info` in prod, `debug` in dev; override with `LOG_LEVEL`.
- Tests assert log output by piping pino into a buffer via `setLogger(pino({level:'trace'}, stream))`.

## Task Lifecycle

A task carries two orthogonal statuses (`packages/types/src/index.ts`):

- `runtime_state: RuntimeState` — `idle | setting_up | running | error | looping`
- `workflow_status: WorkflowStatus` — the board column, `backlog | planned | in_progress | human_review | pr | done`

`setting_up → running → idle` is the usual runtime path (close sets `idle`). Error at any
point → `error` with the message in `task.error`.

Per task: git worktree at `<repo>/.worktrees/<id>`, tmux session `octomux-agent-<id>`,
branch `agents/<id>`. Each **worker** = tmux window within the session.

"Agent" means three distinct things; keep them straight:

| Concept                            | Table     | Routes                                     |
| ---------------------------------- | --------- | ------------------------------------------ |
| per-task tmux worker               | `workers` | `/api/workers`, `/api/tasks/:id/workers`   |
| persistent conductor agent         | `agents`  | `/api/agents`                              |
| agent _role_ definition (markdown) | none      | `/api/agent-roles` (from the plugin files) |

- **close** = stop workers + kill tmux session. Preserves worktree and branch (for resume).
- **delete** = kill tmux session + remove worktree + delete branch + delete DB rows. Full cleanup.

`startTask` logs a `duration_ms` per stage (`stage_timing: true`); `bun run
bench:task-create` reports the breakdown. `git worktree add` dominates.

## Compute providers

**Where a task runs is a decision, not a call site.** `server/compute/` is the seam
that decides where a task's git worktree lives and where its processes run. `local`
(the server's own machine) is the default and is what every existing task uses.

**This is NOT a pluggable isolation strategy.** A git worktree per run is octomux's
guarantee, not a preference — the public docs say so. This seam decides _where that
worktree lives_, nothing more. Don't reintroduce an isolation strategy behind it.

- `ComputeProvider` = `{ kind, create(task, ctx), resume?(task, ctx) }`.
  `ComputeSession` = `{ kind, taskId, repoPath, exec, tmux, spawn, files, dispose }`.
  Both in `server/compute/types.ts`; registry in `registry.ts` mirrors
  `harnesses/registry.ts` (`DEFAULT_COMPUTE_KIND = 'local'`, `CORE_COMPUTE_KINDS`
  frozen before any plugin loads).
- `sessionFor(task)` (`server/compute/index.ts`) is the single entry point — cached
  per `task.id`, so any code already holding a `Task` gets a session in one `await`.
  `localSession` is the task-free server machine; pass it **explicitly** at call
  sites that legitimately read the server's own checkout (diff reads, comment
  hashing, repo probes). An implicit local default is exactly the bug this seam
  exists to remove, so there isn't one.
- The migration rule, if you're touching the task engine: `execTmux(x)` →
  `compute.tmux(x)`, `execFile('git', …)` → `compute.exec(['git', …])`, `fs.*Sync`
  → `await compute.files.*`, pty attach → `compute.spawn({ command })`.
  `task.repo_path` stays the repo's _identity_ (DB key, log field); `compute.repoPath`
  is where it physically is.
- Per-task selection: `tasks.compute TEXT` (NULL → `local`, no backfill needed),
  `POST /api/tasks { compute }`, `octomux create-task --compute <kind>` (generated
  from `taskCreateInputSchema`, no CLI file to edit), `settings.defaultComputeKind`
  and `settings.compute[kind]`.
- Credentials are brokered at the boundary: `computeConfigFor(kind)`
  (`server/compute/config.ts`) splits `settings.compute[kind]` into `config` and a
  `secrets` sub-object, expanding `${env:VAR}` in both, and hands the result to
  `provider.create()` **only**. The agent's environment, its launched command, and
  its worktree never see a broker secret.
- A plugin registers one with `ctx.compute.register({ kind, create })` and gets
  `ctx.host` (`exec`/`spawnPty` on the server) plus `ctx.execBackedFiles(exec)` — the
  only runtime capabilities handed across the types-only `@octomux/plugin-api`
  boundary, and enough to write a remote provider with no host imports and no new
  dependencies. Worked example: `docs/plugins/examples/ssh-compute/`.
- **Known gaps — do not describe as working:** `resume()` is called but the host
  cannot yet tell "reattach after restart" from "first create", so it falls back to
  `create` (see the comment in `sessionFor`); `hop-agent` refuses to move an agent
  between tasks on different compute kinds rather than silently launching fresh;
  `server/chats.ts` and `server/orchestrator/**` are deliberately outside the seam
  (no `Task` — chats and conductor conversations are task-free) and always run local.

## Per-task model override

`tasks.model TEXT` column. Propagated through:

- `POST /api/tasks` body: `{ model: "claude-opus-4-8" }` → stored in DB
- `POST /api/tasks/:id/workers` body: `{ model: ... }` → stored on worker launch
- `octomux create-task --model <id>` and `octomux add-agent --model <id>`
- Harness: `applyModel(flags, model)` strips any existing `--model` then appends the per-task one

## Loops (Ralph loops)

A loop re-runs a task's agent in **fresh context** until a verify command exits 0. Engine in
`server/task-engine/loop/` (`engine.ts` policy + `verify.ts` runner); each iteration respawns the
active agent via `lifecycle/respawn-agent.ts`, so loop tasks are exempt from the idle poller.

```
octomux loop-start --task <id> --prompt <text|@file> --verify '<cmd>' --max-iterations <n> \
                   [--budget-tokens <n>] [--stall-after <n>]
octomux loop-start-group --repo <path> --base-branch <b> --prompt … --verify … \
                   --max-iterations <n> [--n <candidates>]   # fan out N competing candidates
octomux emit --run <loop-run-id> --status done|blocked|needs_human --reason "<why>"
```

- `emit` is how the agent inside the loop reports its own completion back to octomux.
- Termination is layered — stops on any of: `done` + verify passed, `blocked`, `needs_human`,
  `max_iterations`, `budget` (tokens/time), `no_progress` (`--stall-after` N no-op iterations).
- Each iteration appends to a curated playbook in the worktree so the next fresh context sees
  what earlier ones tried.
- UI at `/loops` (list) and `/w/loops/:id` (detail, via the workflow-UI registry); `/loops/:id`
  is a legacy redirect. REST is the generic `/api/runs` surface (`server/routes/runs.ts`), not
  a loops-specific router.
- Spec: `spec/workflow-framework.md`; plans: `plans/2026-07-12-loop-harness-*.md`.

### Learnings

`octomux learn --trigger … --lesson … --evidence … [--private]` and `octomux recall --query …`
persist and retrieve durable notes per repo (`unlearn` / `learn-forget` retire them). Backed by
the `agent_learnings` table and `server/routes/learnings.ts`.

## Schedules

Cron-triggered runs replaced the old `octomux team` command (deleted in `90cf49e`). Multiple
schedules per `(kind, repo_path)` are allowed (the old UNIQUE constraint is gone). Each row
carries a 5-field cron plus per-schedule `name`, `timezone` (IANA, NULL → UTC), `model`,
`timeout_ms` (headless session timeout, NULL → 5 min), `config_json`, and `prompt`.

**Kinds are presets, schedule rows are self-contained** (spec/schedule-kinds-as-presets.md).
A kind is a JSON file — `<pkg>/kinds/*.json` (built-in) plus `~/.octomux/kinds/*.json` (home,
UI-authored, `session`-only, wins on collision) — loaded by `server/workflows/presets.ts` and
merged with the code handlers that `registerWorkflow()` registers. Presets are read **only when
the UI builds a create form**: prompt and config are copied into the row at create time with ajv
defaults materialized on write, so `executeScheduleRun` reads the row and nothing else. There is
no resolution chain, no per-kind DB table, and editing a preset never touches existing schedules.
`listCronWorkflowKinds()` = "kinds that have a preset".

`poller/schedule-cron.ts` calls `isCronDue(expr, now, timezone)` (`server/schedules/cron.ts`,
`croner`) with a same-minute refire guard, and hands due rows to
`poller/execute-schedule-run.ts`, which threads model/timeout into the workflow's `RunContext`.
Session-vertical prompts interpolate `{{configKey}}` placeholders generically
(`server/prompt-interpolate.ts`, single-pass). Managed from `/schedules` and Settings → Kinds
in the UI; `server/routes/schedules.ts` (`GET/POST /api/schedules`, `PATCH`/`DELETE /api/schedules/:id`,
`POST /api/schedules/:id/run`, `GET /api/schedules/:id/runs`,
`GET /api/schedules/:id/export`, `POST /api/schedules/import`, `GET /api/schedules/kinds`)
and `server/routes/kinds.ts` (`GET /api/kinds`, `PUT`/`DELETE /api/kinds/:kind`, home tier only).

## Secrets

**A named store, never a config column.** `secrets` table: `value_enc` is AES-256-GCM
(`server/secrets/crypto.ts`), keyed by `<octomuxRoot()>/secret.key` (32 random bytes,
mode 0600, created on first use; `OCTOMUX_SECRET_KEY` — base64, exactly 32 bytes —
overrides it). Not envelope encryption, not a KMS: it stops a copied `tasks.db` or a
backup from being a credential dump, nothing more.

**No read API returns a value. Ever.** `GET /api/secrets` is metadata only
(name/description/timestamps); there is no `GET /api/secrets/:name`. Writes are
`PUT /api/secrets/:name` and `DELETE /api/secrets/:name`, plus
`octomux secrets list|set|rm` (`set --stdin` keeps the token out of shell history).
Manual replace is the whole v1 rotation story. `listSecrets()` doesn't even SELECT
`value_enc`; `getSecretValue()` is the single decrypt path and is not exported over
HTTP or onto `ctx`.

**Reference by name, resolve at egress.** A config value holds the literal
`${secret:NAME}` — same shape as the older `${env:VAR}` (`integrations/resolve-env.ts`),
resolved by `resolveSecrets()` (`server/secrets/store.ts`). An unknown name **throws**
where `${env:}` degrades to `''`: an empty credential is a 401 three layers away.
Wired at exactly two core egress points — `hook-dispatcher.ts` (integration config,
which now fails closed and skips the send rather than posting a literal placeholder as
a credential) and `compute/config.ts` (the `secrets` sub-object only; `config` stays
env-only, because `config` is the half that can reach the agent).

**Deliberately NOT resolved** in `prompt-interpolate.ts` or `executeScheduleRun`'s
`resolveWorkflowConfig`. Schedule config feeds the agent's prompt through
`{{configKey}}`, so resolving there hands the credential straight to the agent — the
exact failure this exists to prevent. A workflow that needs the value calls
`resolveSecrets()` itself at the call that uses it.

**Redaction is one choke point per egress.** `server/secrets/redact.ts` (zero imports —
`logger.ts` imports it, and going through `store.ts` would cycle via `db.ts`) holds the
set of values seen this process, populated on every write and every decrypt.
`logger.ts` wraps its destination streams with `withRedaction()`, so every `logger.*`
line in the codebase is scrubbed without call sites knowing; `finishRun()` scrubs
`result_json` the same way. Values under `REDACT_MIN_LENGTH` (8) are not redacted —
scrubbing every occurrence of a 4-char string would wreck the logs.

**Plugins:** `ctx.secrets.list()` returns NAMES and is ungated (matching `facts.read` /
`catalog.list`); `ctx.secrets.resolve(value)` returns VALUES and is gated on
`secrets.read`. There is no plugin write path — a secret is written by a human. Nothing
is registered, so nothing deregisters on unmount; `clearPluginGrants` already covers it.

**Marking a config field as a reference:** a `config` JSON Schema property carries
`secretRef: true` and `SchemaConfigForm.tsx` renders a picker of secret names instead of
a text input, storing the wrapped `${secret:NAME}` form. Distinct from `secret: true`
(`integrations/mask.ts`), which means "this field holds a literal secret" — do not
conflate them.

**Known gaps — do not describe as working:** the key sits next to the DB, so an attacker
with the filesystem has both; there is no per-user scoping, no rotation automation, and
no audit log of resolutions. A plugin runs in-process and can read the `secrets` table
and the key file directly — `secrets.read` governs `ctx`, not the process. There is no
Settings UI for creating a secret; the picker is populated by whatever the CLI or API
wrote.

## Skills and agent roles

Both ship in the bundled plugin (`plugin/skills/`, `plugin/agents/`) and reach launched
agents via `--plugin-dir`. **Single source — there is no repo or home tier.** Earlier
revisions had `<repo>/.octomux/{skills,agents}` and `~/.octomux/agents`; nothing ever
delivered them (`syncAgents()` is a no-op in both harnesses), so they were listed over
REST and invisible to every running agent. They are gone; don't reintroduce them.

One narrow exception survives: `octomux add-agent --skeleton <name>` reads
`<worktree>/.octomux/agents/<name>.md` and prepends it to the prompt
(`task-engine/lifecycle/add-agent.ts`). That is a per-worktree file read at launch, not a
discovery tier — nothing lists or serves it.

Users' own skills/subagents live in Claude Code's native `~/.claude/skills/`,
`~/.claude/agents/`, and `<repo>/.claude/` — the harness reads those directly and octomux
neither manages nor lists them. Repo-specific customization goes there.

The skills are also installable into a user's own sessions via the plugin marketplace
(`.claude-plugin/marketplace.json`): `/plugin marketplace add ShreyPaharia/octomux`
then `/plugin install octomux@octomux`.

`workflows/review-deep.js` is a Claude Code _workflow_ script, which plugins cannot ship —
`octomux init` installs it to `~/.claude/workflows/` copy-if-absent.

The six cron-kind `SKILL.md` files were folded into `kinds/*.json`; the prompt lives there
now, and the overlay plugin (`server/octomux-plugin.ts`) is the only delivery path for
task-backed schedule prompts.

## Plugins

octomux is a metaharness: a third-party npm package listed in `~/.octomux/octomux.yml`
(`server/plugins/manifest.ts`, YAML pinned to `JSON_SCHEMA` — no anchors/aliases, no custom
tags) gets `import()`ed at boot and its `apply(ctx)` called once. `ctx` (built by
`createPluginContext()` in `server/plugins/context.ts`) exposes ten registrars —
`ctx.workflows.register()`, `ctx.integrations.register()`, `ctx.harnesses.register()`,
`ctx.compute.register()` (see "Compute providers" above), `ctx.surfaces.register()` (below),
`ctx.http.route()`, `ctx.records` (`define`/`put`/`read`/`query`/`watch`, plus a
`begin`/`end`/`interrupted` checkpoint trio — see below),
`ctx.services` (`provide()`/`require()`, below), `ctx.ui.panel()`,
and `ctx.policy.intercept()` — plus non-registrar methods `ctx.agents.run()`,
`ctx.fanout.run()`, `ctx.attention.ask()`, and the read-only `ctx.catalog.list()`.
`ctx.artifacts` is deliberately **a method on ctx, not a registrar**: nobody needs a different
artifact implementation, they need to write one. `write(taskId, {name, mime, body})` drops a file
at `<worktree>/.octomux/artifacts/<pluginId>/<name>` (metadata in a sibling `index.json`, since
`mime` isn't recoverable from the filesystem) and `list(taskId)` reads back every plugin's
artifacts on that task, unscoped, exactly like `records.read`. `server/services/run-detail.ts`
surfaces them on `GET /api/runs/:id`, so a plugin's output reaches the run detail view with no
further core change. Files land in the task's git worktree — they diff, and they outlive both
the plugin and a DB wipe.
`ctx.agents` is likewise a method, not a registrar: `run({ input, outputSchema, model?,
timeoutMs? })` launches a headless, git-free agent session (default harness, pty substrate —
the same `runAgentSession()` primitive `session-vertical-service.ts` uses for scheduled kinds)
and resolves with the structured result submitted via `submit_result`. It defaults to a fresh
ephemeral scratch dir — no worktree, no tmux, no CLAUDE.md/repo bleed — pass `workspaceDir` for
a real checkout; `timeoutMs` (default 5 min) bounds the wait. There's no host concurrency cap
and no `runs` row; a fan-out plugin owns its own limiter.
Types are pinned in `@octomux/plugin-api` (`packages/plugin-api/src/index.ts`) — **types only**,
nothing runtime crosses that package boundary, because under `bun build --compile` a plugin has
no host `node_modules` tree to import a runtime value from even by accident.

- **Boot order is the correctness property.** `await loadPlugins(...)` runs in `server/index.ts`
  between `acquireInstanceLock()` and the synchronous `createApp()` — `createApp()` snapshots
  the workflow/capability registries, so a workflow or capability registered after it is a
  silent no-op. That snapshot is exactly why `ctx.http`, `ctx.records` and `ctx.ui` are lookup
  tables rather than express mounts: those three CAN be registered and unregistered at any
  time, which is what makes hot reload possible at all. Core
  harnesses/integrations register and freeze (`freezeCoreHarnesses()` etc.) before any plugin
  row loads; a plugin can never redefine `claude-code`, `cursor`, `jira`, or `linear`.
  `reconcile?(ctx)` is in `OctomuxPlugin` but **no wave calls it yet** — don't describe it as
  wired.
- Every plugin id gets qualified as `<pluginId>:<localKind>` (`server/plugins/qualify.ts`)
  before it reaches the real registry, so a plugin never sees or chooses the qualified form.
- Per-row failure is isolated and never throws: a bad resolve/import/apply becomes a
  `LoadReport.failed` entry (`phase: 'resolve' | 'import' | 'apply' | 'reconcile'`) plus a
  `logger.warn`, persisted to `~/.octomux/plugin-load-report.json` for `octomux doctor` to read
  without a running server. `octomux start --safe-mode` (`OCTOMUX_SAFE_MODE=1`) skips every
  plugin row; core harnesses/integrations still register.
- **Capability grants.** A manifest row declares the `ctx` surface its plugin uses:
  `grants: [policy.intercept, records.write]`. Names match the `ctx` path they gate — all 17,
  from `PLUGIN_CAPABILITIES` (`server/plugins/grants.ts`): `workflows.register`,
  `integrations.register`, `harnesses.register`, `compute.register`, `http.route`,
  `records.define`, `records.write`, `services.provide`, `ui.panel`, `ui.action`,
  `artifacts.write`, `policy.intercept`, `agents.run`, `fanout.run`, `surfaces.register`,
  `attention.ask`, `secrets.read`. Reads and self-owned members (`ctx.records.read`/`query`/
  `watch`/`interrupted`, `ctx.catalog.list`, `ctx.secrets.list`, `ctx.artifacts.list`,
  `ctx.services.require`, `ctx.settings`, `ctx.logger`, `ctx.effect`) are ungated. A row with no
  `grants` key gets nothing — the registrar throws, and the row lands in the load report
  as a `phase: 'apply'` failure naming the plugin and the capability. Widening an existing
  row's grants is withheld until acknowledged: the granted set is tracked per row in
  `plugin-grants.json` next to the manifest (first sight of a row grants everything it
  declares; narrowing is free; adding a grant sits pending until `octomux plugins approve
<id>`). `LoadReport.grants`/`pendingGrants` (per plugin id) is what `octomux doctor` prints.
- **`ctx.records`** — the one store for plugin data (SHR-282), replacing the prior
  three-table split (a task-scoped fact log, a durable keyed collection, and a
  plugin-private kv blob store) with one `plugin_records` table
  and one `RecordStoreDefinition` shape: `define({ name, scope, mode, key?, schema? })`.
  `scope: 'task'` dies with the task (the old facts lifetime); `scope: 'durable'` outlives
  unmount (the old collections/kv lifetime). `mode: 'append'` adds a row (facts); `mode:
'upsert'` replaces the row sharing `key` (collections/kv) — `mode:'append'` with a `key`,
  or `mode:'upsert'` without one, are both rejected at `define()` time. Omit `schema` for an
  opaque store (recovers the old kv blob use case). Names qualify to `<pluginId>:<name>`.
  `put(name, record, opts?)` takes a BARE name (cross-plugin writes are out of scope and
  rejected) and validates scope against `opts.taskId` before the payload against schema;
  `read(name, opts)` is task-scoped and requires `opts.taskId`; `query(name, q?)` takes bare
  OR qualified and is unscoped. `QuerySpec` is deliberately tiny: exact-match `where`,
  `orderBy`/`order`, `limit`/`offset`, no operator language. Unmount drops a store's
  _definition_ only when its rows die too (`task` scope) — a `durable` store's definition
  survives, since its rows do. The checkpoint trio (`begin(name, key, value)`/`end(name,
key)`/`interrupted(name?)`, recovered from the old kv blob store) stamps/clears/reads an in-flight marker
  per `(store, key)`, scoped by `name` since one plugin can own several stores; checkpoint
  state is not a registration, so unmount never touches it — deleting it is only ever
  explicit, via an ordinary `put()` on the same key. Gate: `records.define` on `define()`,
  `records.write` on `put()`/`begin()`/`end()`; `read`/`query`/`watch`/`interrupted` are
  ungated. This is what unstranded `ctx.ui`: `UiPanelBinding` binds to a `record` (bare local
  store name), so a panel can render something that outlives a task. Records reach the SPA via
  `GET /api/tasks/:id/records` (task-scoped) and `GET /api/plugin-records/:qualifiedName`
  (unscoped, replacing the old `/api/plugin-collections/:qualifiedName`).
- **`ctx.services`** — dependency by CAPABILITY, not by package name (SHR-260). A plugin
  provides a name (`ctx.services.provide('chat.send', impl)`); another requires it
  (`ctx.services.require('chat.send')`) and gets back `{ name, get() }` that resolves live on
  every call. The one unqualified name in the whole API — `chat.send` has to be the same
  string on both sides, so it isn't prefixed `<pluginId>:` like everything else. **First
  provider wins**: if two plugins provide the same name, the one earlier in `octomux.yml` is
  live and the other queues behind it, promoted only if the first unmounts — there's no
  `prefer:` key, reordering the two rows is the whole mechanism. Resolution happens once, in
  `loader.ts`, after the whole manifest has applied (a fixpoint pass, since unmounting one
  unmet plugin can strand another) — so a consumer may be listed before its provider. An unmet
  `require()` fails only that plugin (and anything transitively depending on it) as a
  `phase: 'apply'` load-report entry, never the boot. Providers show up in `ctx.catalog.list()`
  as `service:<name>`. Requires `services.provide`; `require` is ungated.
- **`ctx.fanout`** — run a step **per item**, not per schedule fire. `run({ name, source, each })`
  maps a handler over an item source: `{ items }` (a plain array), `{ collection, query }` (a
  `ctx.records` query source — the resolver is injected via `setCollectionResolver()`, and
  until it lands a collection source throws a message saying so), or `{ resume: runId }` (redrive).
  Per-item status persists in `fanout_runs` / `fanout_items`, so a partial run is legible
  (`GET /api/fanout/runs[/:id]`) and resumable. Retries are bounded exponential backoff
  (`maxAttempts` 3, `backoffMs` 1000 by default); an item that exhausts them is **dead-lettered**
  and the rest of the run continues. **The concurrency cap is host-enforced and GLOBAL** — one
  semaphore across every plugin's fan-out runs, `settings.fanout.maxConcurrency` (default 4). A
  per-run `concurrency` is clamped down to it, never up. That placement is deliberate and
  cross-ticket: `ctx.agents.run()` (SHR-272) stays a thin accessor, and fan-out is where scheduling
  policy belongs, because fan-out is the runaway case. Unmount aborts in-flight runs without
  awaiting their handlers (a handler may be a multi-minute agent session); interrupted items go
  back to `pending` for a later resume. Deliberately not a DAG — chain by writing to a record store
  and querying it from the next step. No HTTP redrive route: a redrive needs the plugin's live
  `each` closure, which cannot be persisted.
- **`ctx.policy.intercept(point, hook)`** — the one registrar that can refuse, not just add.
  Four points: `task.launch`, `harness.resume`, `review.publish`, `integration.send`. A hook
  returns `{ deny: reason }`, `{ patch: {...} }` (merged into `intent.data`, visible to later
  hooks), or nothing. Hooks for a point run in registration order; first deny short-circuits.
  A hook that throws or exceeds `POLICY_HOOK_TIMEOUT_MS` (5s) is logged and treated as no
  opinion — **fails open**, so a crashing plugin can't wedge every launch. A deny or patch on
  a task-scoped intent is recorded twice: a `core:policy.decision` record and a `task_updates`
  row of kind `policy` (shows in the task's Activity panel). There is deliberately no
  `task.merge` point — core never merges a PR (`server/poller/merged-pr.ts` only observes
  merges that already happened on GitHub), so there's no call site to gate.
- **`ctx.surfaces.register()`** — a place octomux presents itself to a human, beyond the
  four compiled in (`web`, `cli`, `slack`, `telegram`; `CORE_SURFACE_KINDS`, frozen before
  any plugin loads, same as compute). Works only because `ctx.ui` panels are declarative
  bindings, not components: a panel written before the surface existed still renders on it.
  A surface declares the renderer names it draws; the host resolves `panel.as` →
  `panel.renderer` before calling `render` — the declared renderer when supported, otherwise
  the surface's `fallback` (default `json`). Degraded, never dropped, never blank. `prompt`
  is optional; without it the surface is read-only and asking it throws. Requires
  `surfaces.register`.
- `octomux plugins list|disable|enable` edit `octomux.yml` directly, no server required.
  `octomux plugins reload <id>` is different — it goes over the API and needs a running server,
  because it re-imports and re-runs the plugin's `apply()` in the live process. A plugin that
  declares `WorkflowType.apiRouter` reports `unloadable: false` and still needs a restart, since
  express 5 cannot unmount a Router. In dev only, local-path manifest rows are watched and
  reloaded on save. There is no `plugins add`/install command — getting a package onto disk
  (`npm install --prefix ~/.octomux <pkg>`) is on the user today.
- **Known gaps — do not describe as working:** `PluginRow.integrity` is parsed and typechecked but never verified
  against the resolved tarball; harness command builders still return a shell **string**, not
  argv (the injection-safety burden the plan assigns to argv conversion hasn't landed); a
  plugin integration provider's `handler` receives the **resolved** secret in cleartext
  (`server/hook-dispatcher.ts` calls `resolveEnvVars` before invoking it — there's no broker
  yet); `ctx.services`' unmet-requirement check is boot-only — `octomux plugins reload <id>`
  does not re-run it, so a hot-reloaded plugin with an unmet requirement mounts anyway and
  throws at its first `handle.get()` instead of failing at load time. Trust model: a plugin
  runs in-process with the DB handle, every credential, and
  `process.env` — no sandbox, none planned. State that plainly wherever plugins are documented.
  Capability grants (above) and `ctx.policy` denies do not change this: grants govern only the
  `ctx` surface, a plugin can do everything core can do without ever calling `ctx`, and a
  `policy` deny is not containment — it's a coordination/audit mechanism, nothing stops a
  plugin from bypassing its own hook. `octomux plugins approve` (the grant-widening ack) is
  the operator confirming intent, not a security check on the code.
  Two things the plugin runtime added to that blast radius, neither a new class of exposure but
  both worth knowing: a `ctx.http.route()` handler receives the raw request headers, including
  the remote-mode auth token of whoever called it; and `POST /api/plugins/:id/reload` re-imports
  and re-executes on-disk plugin code on request. Both sit behind `remoteAuthMiddleware`.
  All four core surfaces (`web`, `cli`, `slack`, `telegram`) are read-only — octomux's only
  human-question path is still the card-based approval gate (`server/orchestrator/gate.ts`),
  DB-backed and untouched by `ctx.surfaces`. The registrar records the prompt capability so a
  plugin surface can implement one; no core surface does.
- Plan + status: `plans/2026-08-16-plugin-ecosystem.md` (design, "Trust model" section has the
  full threat writeup) and `plans/2026-08-16-plugin-ecosystem-tasks.md` (execution log — STEP-0
  through STEP-2 shipped on `next`; WAVE-3's integration outbound broker, WAVE-4's harness leaks,
  and WAVE-5's argv conversion have not).

## Testing Patterns

- `bun test`, not vitest. Tests keep the vitest shape (`describe/it/expect/vi`) via
  the shim at `server/bun-test.ts` — import from it, never from `vitest`.
  `src/` tests import `src/bun-test.ts`, which re-exports the same surface.
- **`vi.mock()` does not hoist**, and a static `import` is hoisted no matter where it
  sits. Load the module under test with `await import()` _after_ the mocks.
- **Mock factories must be synchronous** — an `async` factory deadlocks a synchronous
  import of the mocked module. `importOriginal()` / `vi.importActual()` return the
  module directly, so don't `await` them.
- **Mock order matters** when a factory loads real modules: mock `child_process`
  before anything whose module scope captures `execFile` (e.g. `tmux-bin`,
  `git-commits`).
- Suites run `--parallel` (implies `--isolate`); without it `mock.module()`
  registrations leak across files in the shared process.
- `NODE_ENV=test` comes from the test scripts — bun does not set it. Without it the
  suite runs in production mode against the real `~/.octomux`.
- Table-driven tests using `it.each()` — prefer over individual test cases
- Shared test harness: `server/test-helpers.ts` (DEFAULTS fixtures, insert/get helpers,
  shell mock assertion helpers via `findExecCall`/`countExecCalls`)
- DB tests use in-memory SQLite via `createTestDb()` → calls `setDb()` for isolation
- task-engine tests mock `child_process` (execFile, spawn) and `fs` (existsSync, mkdirSync, copyFileSync)
- API tests use supertest against `createApp()`
- `OCTOMUX_AI_TASK_NAMING=1` (or `true`) — optional: on task create with `initial_prompt`, run Claude CLI to polish omitted title/description; off by default so POST `/api/tasks` returns immediately without that subprocess
- E2E: Playwright tests in `e2e/`, config in `playwright.config.ts`
- E2E: `webServer` config auto-starts Express + Vite, reuses running servers in dev
- E2E: helpers in `e2e/helpers.ts` — `createTaskViaAPI`, `waitForStatus`, `deleteAllTasks`, `fillCreateDialog`
- E2E: base-ui Dialog dismisses on Playwright `fill()` — use `click({force:true})` + `pressSequentially` instead
- E2E: terminal text leaks into locators — use `getByRole` or `.filter()` to avoid strict mode violations

## Code Style

- Prettier: single quotes, trailing commas, 100 char width, semicolons
- ESLint: `@typescript-eslint/no-explicit-any` is warn (off in test files)
- Conventional commits enforced: `feat(scope): message`, `fix(scope): message`, etc.
- Kebab-case scopes, 100 char header max
- Never add any AI attribution to commits or PRs — no `Co-Authored-By: Claude …` trailers,
  no "Generated with Claude Code" footers, nothing of the kind
- Use template literals for SQL with `datetime('now')` — single quotes inside backticks

## Gotchas

- SQLite `datetime('now')` needs single-quoted `'now'` — use template literals, not regular strings
- `fs` mock for task-engine needs `default: mocked` in vi.mock return (default import)
- Express 5 uses `req.params` differently — use `as Record<string, string>` if needed
- `bun:sqlite` is synchronous — no await needed for DB calls
- `bun:sqlite` `.get()` returns `null` on a miss where better-sqlite3 returned
  `undefined`; `server/sqlite.ts` normalises it back to `undefined`. Go through that
  module, never `bun:sqlite` directly.
- `Bun.Terminal.resize()` updates the tty winsize but does not signal the child —
  `server/pty.ts` sends SIGWINCH itself, or `tmux attach` never reflows
- tmux `base-index` varies per user — always query actual window index via `display-message`/`list-windows`, never hardcode 0
- shadcn/ui uses `@base-ui/react` — use `render={<Button />}` prop, not `asChild`
- assets (`skills/`, `agents/`, `templates/`, `workflows/`, `dist/`) live in a read-only
  `/$bunfs` inside the binary — reach them via `assetRoot()` from `server/assets.ts`,
  which unpacks to `~/.octomux/runtime/<version>/`. `__dirname` does not work.
- pino's `transport:` option resolves targets by module path in a worker thread, which
  a compiled binary can't do — `server/logger.ts` uses pino-roll as an in-process stream
- happy-dom ships `IntersectionObserver`/`ResizeObserver` that never fire; the stubs in
  `src/bun-test-setup.ts` are installed unconditionally and re-applied per isolate
- Frontend test helpers in `src/test-helpers.tsx`: `makeTask()`, `renderWithRouter()`, `mockApi()`
- poller tests: use `findCallback(...args)` to find callback in promisified execFile mocks
- logger path resolution is lazy — tests that stub `os`/`fs` must not expect the log
  dir to exist at module-load time (pino is silent in NODE_ENV=test anyway)
- `task_external_refs.metadata` is a nullable JSON text column — always parse with
  `JSON.parse(row.metadata ?? 'null')` server-side, never expose the raw string. The
  hook dispatcher's `loadTaskExternalRefs(taskId)` helper already does this for
  provider envelopes; route handlers must parse on read too.
- Linear integration uses `@linear/sdk` via `server/integrations/linear/graphql.ts`
  (`createLinearClient` / `invokeLinear`). Pass the bare API key — the SDK sends it
  without a `Bearer` prefix. SDK errors are wrapped as `LinearApiError`.

## Dispatching parallel Claude Code sub-agents in this repo

When working on this codebase via Claude Code, **default to parallel dispatch** — fan
out independent work across sub-agents concurrently. This is the intended way to move
fast on multi-part changes.

To keep parallel `Agent({ isolation: "worktree" })` dispatches reliable (an earlier
wave saw agents leak back into the parent worktree and clobber each other's commits),
always:

- Give each agent a **disjoint file set** — no two concurrent agents editing the same
  file. Split the work so their diffs can't overlap.
- After dispatch, capture each agent's actual worktree path with `git worktree list`.
- Pass the absolute path explicitly in the prompt and tell the agent to `cd` there
  before any file or git operation.
- Verify each agent is on its own distinct branch before it starts committing.

Fall back to sequential dispatch only for a phase whose file sets genuinely can't be
made disjoint (e.g. several changes to the same shared file like `api.ts` or the DB
schema).

This is unrelated to octomux's own runtime tasks (worktree + tmux + agents) — see
"Task Lifecycle" above for that. The note here is purely about Claude Code's
sub-agent harness.
