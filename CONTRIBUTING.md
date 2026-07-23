# Contributing

## Development Setup

```bash
bun install
bun run dev      # starts Express (port 7777) + Vite dev server concurrently
```

### Tech Stack

- **Frontend:** Vite + React 19 + Tailwind CSS 4 + shadcn/ui + React Router 7
- **Backend:** Express 5 + better-sqlite3 (WAL mode) + node-pty + ws
- **Terminal:** xterm.js (bidirectional) → node-pty → `tmux attach`
- **Isolation:** git worktrees per task, tmux sessions per task, tmux windows per agent
- **IDs:** nanoid(12)
- **Runtime:** bun (package manager + script runner), tsx (dev server)

## Architecture

```
server/           Express backend (API, terminal streaming, task lifecycle, DB)
  api.ts          mounts the routers in server/routes/ onto the Express app
  app.ts          extracted createApp() for testability
  routes/         one module per REST surface (tasks, diffs, reviews, loops, …)
  task-engine/    worktree + tmux + harness lifecycle (cleanup.ts: closeTask, deleteTask)
  harnesses/      pluggable agent backends (claude-code.ts, cursor.ts)
  poller/         background pollers (PR detection, merged-PR close, hooks, schedules)
  db.ts           SQLite singleton with getDb() / setDb() / initDb()
  db/             schema.ts + forward-only migrations.ts
  types.ts        re-exports @octomux/types + review-orchestrator types
src/              React SPA (pages, components, lib/api.ts)
cli/              CLI tool for task management
packages/         bun workspaces: types, diff-engine, api-client, test-fixtures
electron/         macOS desktop shell
e2e/              Playwright E2E tests
```

## Task Lifecycle

```
draft → setting_up → running → closed / error
```

Each task gets a git worktree at `<repo>/.worktrees/<id>`, a tmux session `octomux-agent-<id>`, and a branch `agents/<id>`. Each agent runs in a tmux window within the session.

- **Close** — stops agents and kills the tmux session. Worktree and branch are preserved for resume.
- **Delete** — kills tmux session, removes worktree, deletes branch, removes DB rows. Full cleanup.

## Testing

```bash
bun run test           # vitest run (unit + component tests)
bun run test:watch     # vitest in watch mode
bun run test:e2e       # Playwright E2E tests (auto-starts servers)
bun run test:e2e:ui    # Playwright interactive UI mode
```

### Testing Patterns

- vitest with `NODE_ENV=test` (set in vitest.config.ts)
- Table-driven tests using `it.each()` — prefer over individual test cases
- Shared test harness: `server/test-helpers.ts` (DEFAULTS fixtures, insert/get helpers, shell mock assertion helpers via `findExecCall`/`countExecCalls`)
- DB tests use in-memory SQLite via `createTestDb()` → calls `setDb()` for isolation
- task-engine tests mock `child_process` (execFile, spawn) and `fs` (existsSync, mkdirSync, copyFileSync)
- API tests use supertest against `createApp()`
- Frontend test helpers in `src/test-helpers.tsx`: `makeTask()`, `renderWithRouter()`, `mockApi()`

### E2E Notes

- Playwright tests in `e2e/`, config in `playwright.config.ts`
- `webServer` config auto-starts Express + Vite, reuses running servers in dev
- Helpers in `e2e/helpers.ts` — `createTaskViaAPI`, `waitForStatus`, `deleteAllTasks`, `fillCreateDialog`
- base-ui Dialog dismisses on Playwright `fill()` — use `click({force:true})` + `pressSequentially` instead
- Terminal text leaks into locators — use `getByRole` or `.filter()` to avoid strict mode violations

## Code Style

```bash
bun run lint           # ESLint 9 flat config
bun run lint:fix       # auto-fix lint issues
bun run format         # Prettier
bun run format:check   # check formatting
bun run typecheck      # tsc -b across all tsconfig projects
bun run build          # workspace packages + Vite build + tsup server bundle + CLI
```

- Prettier: single quotes, trailing commas, 100 char width, semicolons
- ESLint: `@typescript-eslint/no-explicit-any` is warn (off in test files)
- Conventional commits enforced: `feat(scope): message`, `fix(scope): message`, etc.
- Kebab-case scopes, 100 char header max
