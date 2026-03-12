# octomux-agents

Web dashboard for orchestrating autonomous Claude Code agents. Create tasks, watch agents work in live embedded terminals, get PRs. Runs locally.

## Tech Stack

- **Frontend:** React 19 + Vite + Tailwind CSS 4 + shadcn/ui
- **Backend:** Express 5 + better-sqlite3 (WAL mode) + node-pty + WebSockets
- **Terminal:** xterm.js → node-pty → tmux
- **Isolation:** git worktrees per task, tmux sessions per task

## Install

### From npm

```bash
npm install -g octomux-agents
octomux-agents              # starts dashboard at http://localhost:7777
```

Or run without installing:

```bash
npx octomux-agents
```

### Prerequisites

The following must be available on your system:

- **tmux** — `brew install tmux` (macOS) or `apt install tmux` (Linux)
- **git** — already installed on most systems
- **claude** — [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### From source (development)

```bash
bun install
bun run dev      # starts Express (port 7777) + Vite dev server
```

## CLI

```bash
node cli/dist/index.js create-task --title "..." --description "..." --repo-path /path/to/repo
node cli/dist/index.js list-tasks [--status running]
node cli/dist/index.js get-task <id>
node cli/dist/index.js close-task <id>
```

## Architecture

```
server/           Express backend (API, terminal streaming, task lifecycle, DB)
  api.ts          REST routes
  task-runner.ts  worktree + tmux + claude lifecycle
  db.ts           SQLite singleton
  types.ts        shared types (Task, Agent, TaskStatus, AgentStatus)
src/              React SPA (pages, components, lib/api.ts)
cli/              CLI tool for task management
e2e/              Playwright E2E tests
```

## Task Lifecycle

```
draft → setting_up → running → closed / error
```

Each task gets a git worktree at `<repo>/.worktrees/<id>`, a tmux session `octomux-agent-<id>`, and a branch `agents/<id>`. Each agent runs in a tmux window within the session.

- **Close** — stops agents and kills the tmux session. Worktree and branch are preserved so the task can be resumed later.
- **Delete** — kills tmux session, removes worktree, deletes branch, and removes DB rows. Full cleanup, not reversible.
