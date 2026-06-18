[![npm version](https://img.shields.io/npm/v/octomux)](https://www.npmjs.com/package/octomux)
[![license](https://img.shields.io/github/license/ShreyPaharia/octomux)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ShreyPaharia/octomux)](https://github.com/ShreyPaharia/octomux)

# octomux

> **Coding got faster. Managing agents didn't.**

A local web app to **dispatch, watch, and review** parallel **Claude Code** and **Cursor** agents from one place. Kanban for fleet status. One inbox for every "allow this tool?" prompt. In-app diff review with **Ship**. No cloud. MIT.

```bash
npm install -g octomux && octomux init && cd your-repo && octomux start
```

Open [http://localhost:7777](http://localhost:7777) — describe a task in the composer, pick **Claude Code** or **Cursor**, and watch agents work in place.

![octomux demo](assets/demo.gif)

## From prompt to merged PR

Three phases, one window:

- **01 — Dispatch.** Type a task. Pick Claude Code or Cursor. Hit go. The composer takes plain English, Jira links, or GitHub issue URLs. Drop a second agent on the same branch with one click — or paste a whole list and **bulk-create** a worktree, branch, and agent for each.
- **02 — Watch.** See every agent work, live. Each task streams its own view — files the agent is editing, the diff as it grows, terminal output as it runs. The **Monitor** view tiles every running agent into one grid so you can scan the whole fleet at a glance. When an agent needs permission, the prompt lands in your inbox so you don't have to babysit every pane.
- **03 — Review & Ship.** Diff review in the same window. File tree, per-file reviewed state, inline comments. Hit **Ship** and the PR auto-links to the task — closes itself when the PR merges.

Code never leaves your laptop. No telemetry, no cloud sync. Crash, reboot, close the lid — `octomux start` restores every task, branch, and session.

## Screenshots

|                                                                               |                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Home inbox + composer** — permission prompts, recent activity, dispatch bar | ![Home](assets/screenshots/dashboard-hero.png)           |
| **Command center** — kanban from backlog → done                               | ![Command center](assets/screenshots/command-center.png) |
| **Settings** — default harness, Cursor model & `--force`                      | ![Settings](assets/screenshots/settings-harnesses.png)   |
| **Task cockpit** — agent tabs, live Claude session, Ship, Done                | ![Task detail](assets/screenshots/task-detail.png)       |
| **Diff review** — file tree, reviewed state, inline comments                  | ![Diff](assets/screenshots/diff-review.png)              |

## Features

- **Sessions inbox** — every permission prompt and question lands in one place; reply once, agents keep going. Tab title shows `(N) octomux` when something needs you.
- **Command center** — kanban for backlog → done; drag status, archive, workflow from draft → ship. Empty board? A first-run guide shows you where to start.
- **Monitor grid** — every running agent tiled into one auto-sized grid; scan the whole fleet's activity (active / idle / waiting) without opening each task.
- **Bulk dispatch** — paste a list of prompts or a GitHub issue list and spin up one task — worktree, branch, agent — per line in a single shot.
- **In-app diff review** — compare to `main`, mark files reviewed, queue inline comments, open lazygit in-editor.
- **Dual harnesses** — run **Claude Code** (`claude`) or **Cursor** (`cursor-agent`) per task; mix agents on one task via **Add agent**.
- **Worktrees keep agents off each other** — each task gets its own git worktree and `agents/<task-id>` branch; five agents can edit `auth.ts` at the same time without conflicts on your main tree.
- **Live task view** — see every agent work in real time: files edited, diff growing, terminal output streaming via xterm.js. Attach the same session from the CLI if you prefer.
- **Agents that dispatch agents** — `/create-task`, `/list-tasks`, `/send-agent-message` skills work inside any Claude Code window; recursive dispatch from inside an agent.
- **Agent teams** — reusable crews defined as code in `<repo>/.octomux/team.yaml`: a lead spawns workers from a roster, each with its own model. Run on demand (`octomux team run`) or on a cron schedule.
- **Per-task model** — pin any task or added agent to a specific model (`--model claude-opus-4-8`); mix models across a fleet so the right one lands on each job.
- **Integrations** — Jira wiring plus orchestrator skills for GitHub / auto-review intake.
- **CLI ↔ dashboard parity** — `octomux create-task`, `send-message`, `resume-task` — same tasks the UI shows.
- **Reboot-proof** — WAL SQLite + preserved worktrees across restarts.
- **Local-only** — no telemetry, no cloud sync, no analytics. Your `.env` stays on the host.

## Patterns

Three workflows octomux makes one-click:

### Verifier — two agents, two opinions

Claude wrote it. Drop Cursor on the same branch for a second pass. Same-model self-review is just self-confirmation — a different model reads the diff without inheriting the first agent's assumptions. Catches missing nonce checks, off-by-one TTLs, and the kind of mistakes that pass type-checking but break in prod.

> Finish a task with Claude → hit **Add agent** → pick Cursor → reviews land as inline comments → you arbitrate, Ship.

### Sweep — five PRs by lunch

Paste a Jira filter or GitHub issue list into the composer. Each ticket gets its own worktree, branch, and agent. Mix Claude and Cursor across the batch so the model best at each kind of task ends up on it. Come back from standup to a kanban of ready-to-review PRs.

### Operator — one prompt becomes an epic

Give an agent the orchestrator skills. It plans the work, breaks down the spec, and dispatches subtasks — each one gets its own worktree, mergeable independently. Inside a Claude Code window, the agent itself becomes the user of octomux. You supervise from the dashboard.

> `/create-task`, `/list-tasks`, `/send-agent-message` skills inside any Claude Code window. Recursive dispatch.

## Quick start

```bash
brew install tmux git
npm install -g @anthropic-ai/claude-code    # and/or Cursor CLI
npm install -g octomux
octomux init
cd your-project
octomux start
```

```bash
octomux create-task -t "Add OAuth login" -r .
octomux create-task -t "Spike with Cursor" -r . --harness cursor
```

Step-by-step setup, Jira, and orchestrator skills: [ONBOARDING.md](./ONBOARDING.md)

## How it works

```
DISPATCH → BRANCH → CODE → INBOX → REVIEW → MERGE
```

| Phase        | What happens                                                                |
| ------------ | --------------------------------------------------------------------------- |
| **Dispatch** | Composer, CLI, orchestrator skills, or Jira/GitHub drafts                   |
| **Branch**   | Automatic git worktree + `agents/<task-id>` branch                          |
| **Code**     | tmux session per task; harness launches `claude` or `cursor-agent`          |
| **Inbox**    | Every permission prompt or question collects in one place                   |
| **Review**   | Diff tab, lazygit terminal, mark files reviewed, **Ship** / **Done**        |
| **Merge**    | PR poller links branches; tasks close when their PRs merge                  |
| _Recovery_   | DB + worktrees survive reboot — `octomux start` picks up where you left off |

## CLI

| Command                                  | Description                                              |
| ---------------------------------------- | -------------------------------------------------------- |
| `octomux start`                          | Dashboard at `:7777`                                     |
| `octomux init`                           | Defaults wizard (Jira, base branch, harness prefs)       |
| `octomux create-task`                    | New task (`--harness cursor` optional)                   |
| `octomux list-tasks` / `get-task`        | Inspect tasks                                            |
| `octomux close-task` / `delete-task`     | Stop or fully remove                                     |
| `octomux resume-task`                    | Resume a closed task                                     |
| `octomux add-agent`                      | Another agent window (`--skeleton`, `--model` optional)  |
| `octomux send-message`                   | Message a running agent — course-correct without restart |
| `octomux team run` / `schedule` / `list` | Run or schedule an agent crew from `.octomux/team.yaml`  |

## Architecture

```mermaid
flowchart LR
  subgraph intake [Intake]
    C[Composer]
    CLI[CLI / skills]
  end
  subgraph core [octomux]
    API[API + SQLite]
    IN[Inbox]
    BC[Command center]
  end
  subgraph run [Per task]
    WT[Worktree]
    TM[tmux]
    H[Claude or Cursor]
  end
  C --> API
  CLI --> API
  API --> WT
  API --> TM
  TM --> H
  H -->|hooks| API
  API --> IN
  API --> BC
  WT --> DIFF[Diff review]
  H --> GH[GitHub PR]
  GH -->|poller| API
```

## Requirements

- macOS (ARM64 or x64), Node.js 20+ (24 LTS recommended)
- `tmux`, `git`
- At least one harness: **Claude Code** (`claude`) and/or **Cursor CLI** (`cursor-agent`)
- Recommended: `lazygit`, `neovim`

> First run flags only the deps you're actually missing — install what the setup banner asks for and you're good. Jira and other integrations are configured later from the in-app **Integrations** page.

## Configuration

| Variable / flag           | Purpose                          |
| ------------------------- | -------------------------------- |
| `OCTOMUX_PORT` / `--port` | Dashboard port (default `7777`)  |
| `OCTOMUX_URL`             | CLI → API base URL               |
| `OCTOMUX_DB_PATH`         | Override task DB path            |
| `OCTOMUX_GITHUB_LOGIN`    | Reviewer-request polling account |

## Remote access over Tailscale

octomux binds to `127.0.0.1` by default — reachable only from the host machine. To view
and control sessions from your other devices (phone, second laptop), put them on a
[Tailscale](https://tailscale.com) tailnet and enable remote mode:

1. Install Tailscale on the host and each device; run `tailscale up` on each. Enable
   MagicDNS so the host is reachable by name.
2. Start octomux in remote mode:
   ```bash
   octomux start --bind 0.0.0.0
   # or: OCTOMUX_BIND=0.0.0.0 octomux start
   ```
   On first start a random access token is generated and its file path is logged
   (`~/.octomux/data/remote-token`). Override it with `OCTOMUX_REMOTE_TOKEN=<secret>`.
3. (Optional) Restrict the accepted `Host` header to your tailnet name:
   `OCTOMUX_ALLOWED_HOSTS=mybox.your-tailnet.ts.net`. The `100.64.0.0/10` tailnet IP range
   is accepted automatically.
4. From a device on the tailnet, open `http://<host-magicdns-name>:7777` and sign in once
   with the token. Local (loopback) access never requires the token.

**Security notes:** only devices on your tailnet can reach the port; the token is a second
factor so a single compromised tailnet device cannot silently drive your agents. Binding
`0.0.0.0` also exposes the port on any other LAN the host is on — the token gates those out,
and you can add a host firewall rule limiting port 7777 to the `100.64.0.0/10` range for
belt-and-suspenders. For HTTPS, front octomux with `tailscale serve`.

## FAQ

**What's the difference between octomux and just running tmux + Claude Code?**
octomux adds the kanban, the inbox, and diff review on top. tmux is just plumbing underneath.

**Does it work with Cursor?**
Yes. Pick Claude Code or Cursor per task. Mix them on the same task with **Add agent**.

**What happens if two agents touch the same file?**
They can't — each task runs in its own git worktree on its own branch. Five agents can edit `auth.ts` at the same time without conflicts on your main tree.

**What if my laptop reboots or crashes?**
Run `octomux start`. Tasks, branches, terminals, and review state all come back.

**How do I track what each agent is costing me?**
Each agent's tmux session has its own session log; Claude Code and Cursor both emit token usage there. A first-class cost view in the dashboard is on the roadmap.

## Links

- [GitHub](https://github.com/ShreyPaharia/octomux) · [npm](https://www.npmjs.com/package/octomux) · [octomux.dev](https://octomux.dev)

Issues and PRs welcome.
