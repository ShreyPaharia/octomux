# octomux-agents

Web dashboard for orchestrating autonomous Claude Code agents. Create tasks, watch agents
work in live embedded terminals (xterm.js), get PRs. Localhost tool, not deployed.

## Tech Stack

- **Frontend:** Vite + React 19 + Tailwind CSS 4 + shadcn/ui + React Router 7
- **Backend:** Express 5 + better-sqlite3 (WAL mode) + node-pty + ws
- **Terminal:** xterm.js (bidirectional) → node-pty → `tmux attach`
- **Isolation:** git worktrees per task, tmux sessions per task, tmux windows per agent
- **IDs:** nanoid(12)
- **Runtime:** bun (package manager + script runner), tsx (dev server)

## Commands

- `bun run dev` — starts Express (7777) + Vite concurrently
- `bun run test` — vitest run (server tests only)
- `bun run test:watch` — vitest in watch mode
- `bun run lint` / `bun run lint:fix` — ESLint 9 flat config
- `bun run format` / `bun run format:check` — Prettier
- `bun run typecheck` — tsc --noEmit
- `bun run build` — Vite build + tsc server

## Architecture

- `server/` — Express backend (API, terminal streaming, task lifecycle, DB)
- `src/` — React SPA (pages, components, lib/api.ts)
- `server/types.ts` — shared types (Task, Agent, TaskStatus, AgentStatus)
- `server/db.ts` — SQLite singleton with `getDb()` / `setDb()` / `initDb()`
- `server/app.ts` — extracted `createApp()` for testability
- `server/task-runner.ts` — worktree + tmux + claude lifecycle
- `server/api.ts` — REST routes mounted on Express app

## Task Lifecycle

created → setting_up → running → done/cancelled
Error at any point → error state with message in `task.error`

Per task: git worktree at `<repo>/.worktrees/<id>`, tmux session `octomux-agent-<id>`,
branch `agents/<id>`. Each agent = tmux window within the session.

## Testing Patterns

- vitest with `NODE_ENV=test` (set in vitest.config.ts)
- Table-driven tests using `it.each()` — prefer over individual test cases
- Shared test harness: `server/test-helpers.ts` (DEFAULTS fixtures, insert/get helpers,
  shell mock assertion helpers via `findExecCall`/`countExecCalls`)
- DB tests use in-memory SQLite via `createTestDb()` → calls `setDb()` for isolation
- task-runner tests mock `child_process` (execFile, spawn) and `fs` (existsSync, mkdirSync, copyFileSync)
- API tests use supertest against `createApp()`
- `CLAUDE_INIT_DELAY` is 0 in test env to avoid 3s sleeps

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
