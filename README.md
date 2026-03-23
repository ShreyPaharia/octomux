# octomux

Run multiple Claude Code agents on the same repo without juggling terminals, branches, or broken working trees.

`octomux` is a local dashboard for orchestrating Claude Code agents. It gives each task an isolated git worktree and tmux session, lets you watch agents work in live terminals, and helps you review the resulting changes before anything touches your main branch.

## Why octomux?

- Run multiple Claude Code agents in parallel on the same repository
- Keep your main working tree clean with per-task git worktree isolation
- Watch each agent live from one local dashboard
- Manage tasks from both a browser UI and CLI
- Review isolated branches and PR-ready changes with less context switching

## Who this is for

`octomux` is for developers who are already using Claude Code and want a safer, more organized way to run multiple autonomous coding tasks at once.

It is especially useful if you:

- spin up multiple Claude Code sessions in parallel
- want better isolation than "just open more terminals"
- need visibility into what each agent is doing
- want a repeatable local workflow for task creation, monitoring, and cleanup

## How it works

Each task gets:

- its own git worktree for isolation
- its own branch for changes
- its own tmux session or window for process management
- one or more Claude Code agents working in parallel

You control everything from the CLI, and monitor live progress from the local dashboard.

## Requirements

- **macOS** (ARM64 or x64)
- **Node.js 20+**
- **tmux**: `brew install tmux`
- **git**: `brew install git`
- **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`

## May Be Required During Install

- **Xcode Command Line Tools**: `xcode-select --install`

You may need Xcode Command Line Tools if native dependencies such as `better-sqlite3` or `node-pty` need to be built locally instead of using prebuilt binaries.

## Install

```bash
npm install -g octomux
```

## Quick Start

```bash
cd your-project
octomux start
```

Then open `http://localhost:7777`, create a task, and watch agents work in parallel from the dashboard.

## Typical Workflow

```bash
# 1. Start the local dashboard
octomux start

# 2. Create a task
octomux create-task -t "Add auth flow" -r .

# 3. Add another agent if needed
octomux add-agent <task-id>

# 4. Check progress
octomux list-tasks
octomux get-task <task-id>
```

## CLI Commands

| Command                                           | Description                                     |
| ------------------------------------------------- | ----------------------------------------------- |
| `octomux start`                                   | Launch the local web dashboard                  |
| `octomux create-task`                             | Create a new task                               |
| `octomux list-tasks`                              | List all tasks                                  |
| `octomux get-task <id>`                           | Get task details                                |
| `octomux close-task <id>`                         | Stop agents and preserve the worktree           |
| `octomux delete-task <id>`                        | Fully clean up task state, branch, and worktree |
| `octomux resume-task <id>`                        | Resume a previously closed task                 |
| `octomux add-agent <task-id>`                     | Add an agent to an existing task                |
| `octomux send-message <task-id> <agent-id> "msg"` | Send a message to an agent                      |

## Configuration

| Option          | Description                     | Default                 |
| --------------- | ------------------------------- | ----------------------- |
| `--port <port>` | Port for the dashboard          | `7777`                  |
| `--no-open`     | Do not auto-open the browser    | none                    |
| `PORT`          | Alternative to `--port`         | `7777`                  |
| `OCTOMUX_URL`   | Server URL used by CLI commands | `http://localhost:7777` |

## Why not just use multiple terminals?

You can, but it gets messy fast.

`octomux` adds:

- isolated git worktrees per task
- a single dashboard for monitoring agent activity
- structured task lifecycle management
- less risk of agents stepping on your active working directory

## Current Limitations

- macOS only for now
- requires Claude Code CLI to be installed locally
- built for local-first workflows, not hosted orchestration

## Links

- GitHub: [github.com/ShreyPaharia/octomux](https://github.com/ShreyPaharia/octomux)
- npm: [npmjs.com/package/octomux](https://www.npmjs.com/package/octomux)
- Landing page: [octomux.dev](https://octomux.dev)
