# Getting Started with octomux

Install once, open the dashboard, dispatch your first agent. Optional sections cover harness choice (Claude vs Cursor), Jira, and GitHub.

## 1. Prerequisites

```bash
brew install tmux git neovim lazygit
npm install -g @anthropic-ai/claude-code   # Claude Code harness
npm install -g octomux
```

**Cursor harness (optional):** install the [Cursor CLI](https://cursor.com/docs/cli) so `cursor-agent` is on your PATH. You can run Claude-only, Cursor-only, or both and switch per task.

`octomux start` runs a preflight for missing binaries. If native modules fail to build, run `xcode-select --install` and retry.

## 2. Defaults (`octomux init`)

Writes `~/.octomux/settings.json` (Jira base URL, project key, default base branch). All fields are optional.

```bash
octomux init
# non-interactive:
octomux init --jira-url https://your-co.atlassian.net \
             --jira-project PROJ \
             --base-branch main \
             --non-interactive
```

## 3. Choose your coding agent (harness)

Open **Settings** after first launch:

| Setting             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| **Default harness** | Composer and new tasks default to Claude Code or Cursor              |
| **Claude Code**     | CLI flags, dangerously-skip-permissions                              |
| **Cursor**          | Default model (`cursor-agent --list-models`), `--force`, extra flags |

In the **composer** (home dock), use the **Coding agent** control to override the default for a single task.

**CLI:**

```bash
octomux create-task -t "Fix bug" -r .                    # default harness
octomux create-task -t "Spike UI" -r . --harness cursor  # Cursor CLI
```

**Per-agent mix:** on a running task, **Add agent** can attach a second window under either harness (e.g. Claude plans, Cursor implements).

Custom agent personas live under **Settings → Agents** (`.md` files). Claude uses them via `--agent`; Cursor gets matching rules under each worktree’s `.cursor/rules/`.

## 4. GitHub CLI (optional)

```bash
brew install gh && gh auth login
```

PR linking and auto-close on merge use `gh`. Override the watched account with `OCTOMUX_GITHUB_LOGIN` if needed.

## 5. Jira (optional)

**MCP (ticket fetch in agents):** authenticate once inside Claude Code (or your agent tool of choice).

**`jira-status` hook (ticket transitions):**

```bash
export JIRA_BASE_URL=https://your-company.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_TOKEN=your-api-token
octomux hooks-install jira-status
```

## 6. Launch

```bash
cd path/to/your/repo
octomux start    # http://localhost:7777
```

### First session

1. **Home** (`/`) — **Sessions inbox** + floating **composer**; pick **Claude Code** or **Cursor** in the coding-agent chip.
2. **Command center** (`/tasks`) — kanban board; drag tasks across workflow columns.
3. **Workspaces** (sidebar → More) — list worktrees created for tasks.
4. **Settings** → **Coding agent** — default harness, Cursor model / `--force`; **Integrations** for Jira.
5. **Task detail** — agent terminals, **Diff** review, **Editor** (lazygit), **Info** panels.

Create from CLI anytime:

```bash
octomux create-task -t "Add auth flow" -r .
octomux create-task -t "Try Cursor on this" -r . --harness cursor
```

Draft first if you want to edit title, prompt, and branch before agents start — check **Save as draft** in the composer.

## 7. Where things live

| Path                          | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `~/.octomux/settings.json`    | Defaults (editor, Jira, harness flags, default harness) |
| `~/.octomux/data/tasks.db`    | Task state (production)                                 |
| `./data/tasks.db`             | Task state (development)                                |
| `~/.octomux/logs/`            | Server + hook logs                                      |
| `~/.octomux/hooks/<event>.d/` | Lifecycle hooks                                         |
| `~/.octomux/agents/`          | Custom agent definitions (Claude + Cursor)              |
| `~/.claude/skills/`           | Skills installed for Claude Code                        |
| `<repo>/.worktrees/<task-id>` | Per-task git worktree                                   |
| `<worktree>/.octomux-hooks/`  | Cursor hook bridge (Cursor tasks)                       |
| `<worktree>/.cursor/rules/`   | Cursor rules synced from agent definitions              |

## Troubleshooting

| Issue                      | Fix                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Missing binary on start    | `brew install <name>` or install Claude / Cursor CLI                                    |
| `cursor-agent` not found   | Install [Cursor CLI](https://cursor.com/docs/cli); verify with `cursor-agent --version` |
| Wrong harness on new tasks | Settings → default harness, or pass `--harness cursor`                                  |
| `gh` not authenticated     | `gh auth login`                                                                         |
| Jira MCP not authenticated | Auth inside your agent IDE (separate from `JIRA_TOKEN`)                                 |
| No default branch          | Pass `--base-branch main` when creating tasks                                           |
| Leftover worktree          | `octomux delete-task <id>` (full cleanup) vs `close-task` (keeps branch for resume)     |

More detail: [README](./README.md).
