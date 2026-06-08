# octomux

npm package (`octomux`) for orchestrating autonomous Claude Code agents from a web dashboard.
Single binary: `octomux <command>`. Data stored at `~/.octomux/` in production,
`./data/` in development (`NODE_ENV !== 'production'`).

## Tech Stack

- **Frontend:** Vite + React 19 + Tailwind CSS 4 + shadcn/ui + React Router 7
- **Backend:** Express 5 + better-sqlite3 (WAL mode) + node-pty + ws
- **Terminal:** xterm.js (bidirectional) → node-pty → `tmux attach`
- **Isolation:** git worktrees per task, tmux sessions per task, tmux windows per agent
- **IDs:** nanoid(12)
- **Runtime:** bun (package manager + script runner), tsx (dev server)
- **Binary:** single `octomux` command (`bin/octomux.js`) — `start` launches dashboard, all other subcommands are CLI operations

## Commands

- `bun run dev` — starts Express (7777) + Vite concurrently
- `bun run test` — vitest run (unit + component tests)
- `bun run test:watch` — vitest in watch mode
- `bun run test:e2e` — Playwright E2E tests (auto-starts servers)
- `bun run test:e2e:ui` — Playwright interactive UI mode
- `bun run lint` / `bun run lint:fix` — ESLint 9 flat config
- `bun run format` / `bun run format:check` — Prettier
- `bun run typecheck` — tsc --noEmit
- `bun run build` — Vite build + tsc server

## Architecture

- `server/` — Express backend (API, terminal streaming, task lifecycle, DB)
  - `api.ts` — REST routes mounted on Express app
  - `app.ts` — extracted `createApp()` for testability
  - `task-runner.ts` — worktree + tmux + harness lifecycle (closeTask, deleteTask)
  - `db.ts` — SQLite singleton with `getDb()` / `setDb()` / `initDb()`
  - `logger.ts` — pino root + `childLogger('<module>')` helper
  - `types.ts` — shared types (Task, Agent, TaskStatus, AgentStatus)
  - `harnesses/` — pluggable harness implementations (Claude Code today; Cursor planned).
    Each `Harness` exports `id`, `displayName`, `sessionIdMode`, command builders,
    `installHooks`, `syncAgents`, `resolveFlags`, `validateSettings`. Spec at
    `spec/harness-abstraction.md`; step plan at `plans/2026-05-08-harness-abstraction-step-1.md`.
  - `hook-base-url.ts` — `hookBaseUrl()` returns `http://127.0.0.1:<port>` for harness callbacks.
  - `teams.ts` — team feature: `parseTeamConfig`, `validateTeamConfig`, `runTeam`, `upsertTeamSchedule`,
    `listTeamSchedules`, `cronMatches`, `pollTeamSchedules`. Config lives in `<repo>/.octomux/team.yaml`.
- `src/` — React SPA (pages, components, lib/api.ts)
- `cli/` — CLI tool for task management (create-task, list-tasks, get-task, close-task)
- `e2e/` — Playwright E2E tests

DB migrations are forward-only. Back up `~/.octomux/octomux.sqlite` (prod) or
`./data/octomux.sqlite` (dev) before upgrading across the harness-abstraction
migration (renames `agents.claude_session_id` → `harness_session_id`, adds
`tasks.harness_id` / `agents.harness_id` / `agents.hook_token`, relaxes
`permission_prompts.session_id` to nullable).

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

draft → setting_up → running → closed/error
Error at any point → error state with message in `task.error`

Per task: git worktree at `<repo>/.worktrees/<id>`, tmux session `octomux-agent-<id>`,
branch `agents/<id>`. Each agent = tmux window within the session.

- **close** = stop agents + kill tmux session. Preserves worktree and branch (for resume).
- **delete** = kill tmux session + remove worktree + delete branch + delete DB rows. Full cleanup.

## Agent Teams

Reusable crews of agents that run on a schedule against any repo. Config-as-code: definitions
live in `<repo>/.octomux/team.yaml`; octomux reads at run time, never stores in DB.

### CLI commands

```
octomux team run <name> [-r <repo-path>]       # fire immediately from .octomux/team.yaml
octomux team schedule <name> --cron <expr> [-r <path>]  # upsert cron schedule
octomux team list                              # list configured schedules
```

### team.yaml schema

```yaml
name: my-team # must match name passed to CLI
base_branch: main # optional; default main
schedule: '0 7 * * 1-5' # optional; only used as reference — use `team schedule` to activate
notify_command: "slack-notify.sh '#alerts'" # optional; passed to Lead
journal_dir: desk/journal # optional; default desk/journal
incidents_dir: desk/incidents # optional; default desk/incidents
roster:
  - role: lead # REQUIRED; exactly one lead
    skeleton: desk-lead # filename under agents/ (no .md)
    model: claude-opus-4-8
    overlay: .octomux/overlays/lead.md # optional repo-specific override
  - role: researcher
    skeleton: researcher
    model: claude-sonnet-4-6
  - role: risk-ops
    skeleton: risk-ops
    model: claude-sonnet-4-6
```

### Skeletons

Generic agent skeletons live in `agents/<name>.md` (same dir as `orchestrator.md`).
Built-in: `desk-lead`, `researcher`, `risk-ops`. A Lead receives the full roster in its
kick-off prompt and spawns workers via `octomux create-task --model <model> ...`.

### Per-task model override

`tasks.model TEXT` column added in Phase 0. Propagated through:

- `POST /api/tasks` body: `{ model: "claude-opus-4-8" }` → stored in DB
- `POST /api/tasks/:id/agents` body: `{ model: ... }` → stored on agent launch
- `octomux create-task --model <id>` and `octomux add-agent --model <id>`
- Harness: `applyModel(flags, model)` strips any existing `--model` then appends the per-task one

### DB tables (additive migrations)

```sql
-- operational state only; definitions stay in team.yaml
team_schedules (name PK, repo_path, config_path, cron, enabled, last_run_at, created_at, updated_at)
team_runs      (id PK, team, lead_task_id → tasks.id, started_at, status)
```

### Poller integration

`startPolling()` sets a 60 s interval calling `pollTeamSchedules()`. For each enabled schedule:

1. evaluate 5-field cron (`* * * * *`) against current UTC minute
2. skip if a `team_runs` row with `status='running'` already exists (idempotent)
3. call `runTeam()`, insert `team_runs` row, update `last_run_at`

Cron parser supports exact values and `*` only — no ranges, steps, or lists.

## Testing Patterns

- vitest with `NODE_ENV=test` (set in vitest.config.ts)
- Table-driven tests using `it.each()` — prefer over individual test cases
- Shared test harness: `server/test-helpers.ts` (DEFAULTS fixtures, insert/get helpers,
  shell mock assertion helpers via `findExecCall`/`countExecCalls`)
- DB tests use in-memory SQLite via `createTestDb()` → calls `setDb()` for isolation
- task-runner tests mock `child_process` (execFile, spawn) and `fs` (existsSync, mkdirSync, copyFileSync)
- API tests use supertest against `createApp()`
- `CLAUDE_INIT_DELAY` is 0 in test env to avoid 3s sleeps
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
- Use template literals for SQL with `datetime('now')` — single quotes inside backticks

## Gotchas

- SQLite `datetime('now')` needs single-quoted `'now'` — use template literals, not regular strings
- `fs` mock for task-runner needs `default: mocked` in vi.mock return (default import)
- Express 5 uses `req.params` differently — use `as Record<string, string>` if needed
- better-sqlite3 is synchronous — no await needed for DB calls
- node-pty `spawn-helper` may lack +x after install — postinstall script fixes this
- tmux `base-index` varies per user — always query actual window index via `display-message`/`list-windows`, never hardcode 0
- shadcn/ui uses `@base-ui/react` — use `render={<Button />}` prop, not `asChild`
- vitest projects: put `globals: true` in each project config individually, not just top-level
- Frontend test helpers in `src/test-helpers.tsx`: `makeTask()`, `renderWithRouter()`, `mockApi()`
- poller tests: use `findCallback(...args)` to find callback in promisified execFile mocks
- logger path resolution is lazy — tests that stub `os`/`fs` must not expect the log
  dir to exist at module-load time (pino is silent in NODE_ENV=test anyway)
- `task_external_refs.metadata` is a nullable JSON text column — always parse with
  `JSON.parse(row.metadata ?? 'null')` server-side, never expose the raw string. The
  hook dispatcher's `loadTaskExternalRefs(taskId)` helper already does this for
  provider envelopes; route handlers must parse on read too.
- Linear API uses the bare API key in the `Authorization` header (no `Bearer` prefix)
  — see `server/integrations/linear/graphql.ts`.
- Linear errors come back as HTTP 200 with an `errors[]` array. `linearGraphql`
  throws `LinearApiError` for those; callers must catch.

## Dispatching parallel Claude Code sub-agents in this repo

When working on this codebase via Claude Code, parallel `Agent({ isolation: "worktree" })`
dispatches have proved unreliable: agents leaked back into the parent worktree and
clobbered each other's commits during the wave-2 implementation. Until that's
verified end-to-end, default to **sequential dispatch** — one sub-agent at a time, or
a single agent for an entire wave.

If you must run agents in parallel:

- After dispatch, capture each agent's actual worktree path with `git worktree list`.
- Pass the absolute path explicitly in the prompt and tell the agent to `cd` there
  before any file or git operation.
- Verify both agents are on distinct branches before they start committing.

This is unrelated to octomux's own runtime tasks (worktree + tmux + agents) — see
"Task Lifecycle" above for that. The note here is purely about Claude Code's
sub-agent harness.
