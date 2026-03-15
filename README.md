# octomux

Orchestrate autonomous Claude Code agents from a web dashboard.
Create tasks, watch agents work in live terminals, get PRs.

## Prerequisites

- **macOS** (ARM64 or x64)
- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Xcode Command Line Tools** — `xcode-select --install`
- **tmux** — `brew install tmux`
- **git** — `brew install git`
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

## Install

```bash
npm install -g octomux
```

## Quick Start

```bash
cd your-project
octomux init          # scaffold .claude/ settings
octomux start         # open dashboard at http://localhost:7777
```

## CLI Commands

| Command                                           | Description                                  |
| ------------------------------------------------- | -------------------------------------------- |
| `octomux start`                                   | Launch the web dashboard                     |
| `octomux init`                                    | Scaffold `.claude/` settings in current repo |
| `octomux create-task`                             | Create a new task                            |
| `octomux list-tasks`                              | List all tasks                               |
| `octomux get-task <id>`                           | Get task details                             |
| `octomux close-task <id>`                         | Stop agents, preserve worktree               |
| `octomux delete-task <id>`                        | Full cleanup (worktree, branch, DB)          |
| `octomux resume-task <id>`                        | Resume a closed task                         |
| `octomux add-agent <task-id>`                     | Add an agent to a task                       |
| `octomux send-message <task-id> <agent-id> "msg"` | Send a message to an agent                   |

## Configuration

| Option                | Description                      | Default                 |
| --------------------- | -------------------------------- | ----------------------- |
| `--port <port>`       | Port for the dashboard           | `7777`                  |
| `--no-open`           | Don't auto-open browser on start | —                       |
| `PORT` env var        | Alternative to `--port`          | `7777`                  |
| `OCTOMUX_URL` env var | Server URL for CLI commands      | `http://localhost:7777` |

## How It Works

Each task gets a **git worktree** for isolation, a **tmux session** for process management, and one or more **Claude Code agents** running in tmux windows. Watch it all from the web dashboard with live terminal streaming.

## Links

- [octomux.dev](https://octomux.dev) (coming soon)
- [npm](https://www.npmjs.com/package/octomux)
