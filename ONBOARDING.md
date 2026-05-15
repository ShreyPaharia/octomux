# Getting Started with octomux

This guide walks you through installing octomux, configuring optional integrations
(Jira, GitHub), and creating your first task. If you already have `octomux start`
working and just want to set defaults, skip to [Configure defaults](#configure-defaults).

## 1. Install prerequisites

octomux runs on macOS (ARM64 or x64) and needs Node.js 20+. The `octomux start`
preflight will check for the binaries below and tell you what's missing, but you
can install them up front:

```bash
brew install tmux git neovim lazygit
npm install -g @anthropic-ai/claude-code   # the `claude` CLI
```

If `better-sqlite3` or `node-pty` fail to install, run
`xcode-select --install` and retry.

## 2. Install octomux

```bash
npm install -g octomux
```

## 3. Configure defaults

Run the interactive setup wizard. It writes optional defaults to
`~/.octomux/settings.json` so skills (`create-task`, `create-pr`, etc.) know how
to format branch names, Jira URLs, and base branches for your projects.

```bash
octomux init
```

You'll be prompted for:

| Field               | Example                              | Used for                                                                        |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| Jira base URL       | `https://your-company.atlassian.net` | Linking and inferring Jira tickets when an agent only has a key like `PROJ-123` |
| Jira project key    | `PROJ`                               | Default project for branch naming + ticket inference                            |
| Default base branch | `main`                               | Fallback base branch when creating tasks                                        |

All fields are optional — press Enter to skip. To run non-interactively (e.g.
in a provisioning script):

```bash
octomux init --jira-url https://your-co.atlassian.net \
             --jira-project PROJ \
             --base-branch main \
             --non-interactive
```

## 4. Authenticate the GitHub CLI (optional, for PR workflows)

The `create-pr` skill and PR poller use `gh`. If you don't already have it set
up:

```bash
brew install gh
gh auth login
```

octomux auto-detects your GitHub login from `gh api user`. If you want it to
watch a different account (for "added as reviewer" tasks), set
`OCTOMUX_GITHUB_LOGIN`:

```bash
export OCTOMUX_GITHUB_LOGIN=your-handle
```

## 5. Set Jira credentials (optional, for Jira intake / hooks)

Skills that fetch Jira tickets via the Atlassian MCP need the MCP to be
authenticated, which you do once from inside Claude Code. The `jira-status`
hook (which transitions Jira tickets as octomux tasks move columns) uses three
environment variables instead — add these to your shell config (`~/.zshrc` or
`~/.bashrc`):

```bash
export JIRA_BASE_URL=https://your-company.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_TOKEN=your-api-token   # from id.atlassian.com/manage-profile/security/api-tokens
```

Then install the hook:

```bash
octomux hooks-install jira-status
```

## 6. Launch the dashboard

```bash
cd path/to/your/repo
octomux start          # opens http://localhost:7777 in your browser
```

## 7. Create your first task

From the CLI:

```bash
octomux create-task -t "Add auth flow" -r .
```

Or click **New Task** in the dashboard. See the [README](./README.md#cli-commands)
for the full command reference.

## Where things live

| Path                          | What                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `~/.octomux/settings.json`    | Your defaults (editor, Jira, base branch, claude flags)        |
| `~/.octomux/data/tasks.db`    | Task state (SQLite)                                            |
| `~/.octomux/logs/`            | Server + hook logs                                             |
| `~/.octomux/hooks/<event>.d/` | Lifecycle hook scripts (installed via `octomux hooks-install`) |
| `~/.claude/skills/`           | Skills installed for Claude Code (auto-installed on first run) |
| `<repo>/.worktrees/<task-id>` | Per-task git worktree                                          |

## Troubleshooting

- **`octomux start` says a binary is missing** — install it with `brew install <name>` and re-run.
- **`gh` says "not authenticated"** — `gh auth login`.
- **Jira MCP says "not authenticated"** — open Claude Code and follow the Atlassian MCP auth prompt; this is independent of `JIRA_TOKEN` (which is only for the `jira-status` hook).
- **`default-branch` fails** — your repo may have no remote. Pass `--base-branch main` explicitly when creating tasks.
- **Worktree leftovers** — `octomux delete-task <id>` removes the worktree + branch; `close-task` keeps them for resume.
