[![npm version](https://img.shields.io/npm/v/octomux)](https://www.npmjs.com/package/octomux)
[![license](https://img.shields.io/github/license/ShreyPaharia/octomux)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ShreyPaharia/octomux)](https://github.com/ShreyPaharia/octomux)

# octomux

> **The IDE was built for typing. You're not typing anymore.**

octomux is a workbench for **agentic coding** — the layer where you dispatch, watch, review, and ship the work of many **Claude Code** and **Cursor** agents at once. Kanban for fleet status. One inbox for every "allow this tool?" prompt. In-app diff review with **Ship**. Run it from npm, the macOS app, or a box on your tailnet you reach from any device. No cloud. MIT.

```bash
npm install -g octomux && octomux init && cd your-repo && octomux start
```

Open [http://localhost:7777](http://localhost:7777) — describe a task in the composer, pick **Claude Code** or **Cursor**, and watch agents work in place.

![octomux demo](assets/demo.gif)

## The thesis

The editor was designed around a human typing one file at a time. That's not the job anymore. The job is directing a fleet of agents — and the hard part moved from *writing* code to *reviewing* it, *unblocking* it, and *knowing what's happening* across ten parallel sessions.

octomux is a bet on what that surface should look like. Not a chat box bolted onto a file tree — a control deck. It handles the ugly backend of running agents (isolated git worktrees, tmux sessions, permission plumbing, hook callbacks, live streams) and puts the *human's* job front and center: an inbox, a fleet grid, a diff reviewer, an orchestrator view. Each of those is just a lens over the same managed backend — and we think the best lenses haven't been built yet.

That's the direction: an open foundation, and a growing set of purpose-built views for working with agent output — shaped in the open, with the community. This isn't a settled product. It's the most useful version we can build of a tool that shouldn't exist yet.

## From prompt to merged PR

Three phases, one window:

- **01 — Dispatch.** Type a task. Pick Claude Code or Cursor. Hit go. The composer takes plain English, Jira or Linear links, or GitHub issue URLs. Drop a second agent on the same branch with one click — or paste a whole list and **bulk-create** a worktree, branch, and agent for each.
- **02 — Watch.** See every agent work, live. Each task streams its own view — files the agent is editing, the diff as it grows, terminal output as it runs. The **Monitor** grid tiles every running agent so you can scan the whole fleet at a glance. When an agent needs permission, the prompt lands in your inbox so you don't babysit panes.
- **03 — Review & Ship.** Diff review in the same window — file tree, per-file reviewed state, inline comments you can send straight back to the agent to fix. Hit **Ship** and the PR auto-links to the task, then closes itself when the PR merges.

Code never leaves your machine. No telemetry, no cloud sync. Crash, reboot, close the lid — `octomux start` restores every task, branch, and session.

## Views

octomux is a set of lenses over one managed agent backend. Today's views:

- **Home / Sessions inbox** — every permission prompt and question across every agent in one place; reply once, agents keep going. Tab title shows `(N) octomux` when something needs you.
- **Command center** — kanban across the real workflow (backlog → planned → in progress → review → PR → done). Drag status, filter to what needs attention, trash with a restore grace period.
- **Task cockpit** — per task: agent tabs with live terminals, diff review, an in-app editor (neovim) mode, and the Ship / Review / Done / Add-agent toolbar.
- **Monitor grid** — every running agent's terminal tiled into one live wall; spot the stuck one without opening each task.
- **Orchestrator** — watch an agent that dispatches agents: the parent planning, its children coding, who's blocked — the whole tree in one view.
- **Reviews** — a full automated-PR-review workstation (see below).
- **Chats** — detach an agent from a task, or spin up a standalone one, as its own terminal session — for a quick spike that isn't a whole task yet.
- **Workspaces** — manage the reusable git worktrees behind your tasks; start new work on an existing checkout, forget or delete.
- **Skill & Agent editors** — author and edit your Claude Code skills and subagent definitions right in the browser.

## Automated code review, human-gated

octomux ships a review workstation, not just a diff tab. Point it at a branch or let it pull in PRs where you're a requested reviewer, and an agent produces a structured walkthrough plus draft inline comments — grounded against the real diff, never hallucinated line numbers.

- **Nothing is posted without you.** Drafts live locally; only comments you accept get published, as a single batched GitHub review with the verdict you choose (comment / approve / request changes). Suggestions render as GitHub `suggestion` blocks.
- **It stays honest as code moves.** Comments are anchored to commits and auto-marked stale when lines shift; you can incrementally re-review after the branch advances.
- **It learns.** Reject a comment with a reason and octomux records a repo-scoped learning that future reviews apply.

## Run it anywhere you are

- **npm CLI** — `octomux start`, localhost, single command. `tmux` ships bundled (macOS + Linux, arm64/x64) — no separate install.
- **macOS desktop app** — download the `.dmg` from [Releases](https://github.com/ShreyPaharia/octomux/releases). Bundles its own tmux and runs against an isolated data dir, so it never collides with a CLI install.
- **On a box, from any device** — bind to your tailnet and reach the dashboard from your phone or second laptop, with a token gate. The UI is mobile-ready: bottom nav, responsive pages, touch-friendly terminal. Answer a permission prompt from the couch. (Setup under [Remote access over Tailscale](#remote-access-over-tailscale).)

## Fleet features

- **Worktrees keep agents off each other** — each task gets its own git worktree and `agents/<task-id>` branch; five agents can edit `auth.ts` at once without conflicts on your main tree.
- **Agent teams** — reusable crews defined as code in `<repo>/.octomux/team.yaml`: a lead spawns workers from a roster, each with its own model. Run on demand (`octomux team run`) or on a cron schedule.
- **Per-task model** — pin any task or added agent to a specific model (`--model claude-opus-4-8`); mix models across a fleet so the right one lands on each job.
- **Completion notifications** — link a worker to an orchestrator with `add-agent --notify-agent`; the lead gets pinged as each worker finishes. Teams wire this up automatically.
- **Agents that dispatch agents** — `/create-task`, `/list-tasks`, `/send-agent-message` skills work inside any Claude Code window; recursive dispatch, watched from the Orchestrator view.
- **Bulk dispatch** — paste a list of prompts or a GitHub issue list and spin up one task — worktree, branch, agent — per line, in one shot.
- **Integrations** — Jira and Linear sync (status push + comment-back, composer prefill); GitHub PR polling, merged-PR auto-close, and reviewer-request auto-review intake.
- **CLI ↔ dashboard parity** — every task the UI shows is scriptable from the CLI.
- **Reboot-proof** — WAL SQLite + preserved worktrees across restarts.
- **Local-only** — no telemetry, no cloud sync, no analytics. Your `.env` stays on the host.

## Built to extend

octomux keeps a clean line between the **agent backend** (hard, done for you) and the **views** (where the value is, and where there's room). If you want to build on it:

- **REST API** (~95 endpoints) over tasks, agents, diffs, reviews, chats, workspaces, skills, settings, and integrations.
- **Two live WebSocket channels** — `/ws/events` for task/chat/review events, `/ws/terminal/*` for bidirectional xterm ↔ tmux.
- **A queryable SQLite schema** — tasks, agents, permission prompts, review runs, comments, learnings, and more.
- **A pluggable harness interface** — add a new agent backend (beyond Claude Code and Cursor) by implementing one interface and registering it.
- **User hook scripts** — drop executables in `~/.octomux/hooks` or `<repo>/.octomux/hooks` to fire on task-lifecycle events.

> **On custom views:** today the UI ships as a React app, and adding a new view means building against these building blocks in the codebase — there isn't a drop-in plugin API yet. A first-class way for the community to author and share views is the direction we're building toward. If that's what you want, [open an issue](https://github.com/ShreyPaharia/octomux/issues) — it shapes the roadmap.

## Patterns

Three workflows octomux makes one-click:

### Verifier — two agents, two opinions

Claude wrote it. Drop Cursor on the same branch for a second pass. Same-model self-review is just self-confirmation — a different model reads the diff without inheriting the first agent's assumptions. Catches missing nonce checks, off-by-one TTLs, and the mistakes that pass type-checking but break in prod.

> Finish with Claude → **Add agent** → pick Cursor → reviews land as inline comments → you arbitrate, Ship.

### Sweep — five PRs by lunch

Paste a Jira filter or GitHub issue list into the composer. Each ticket gets its own worktree, branch, and agent. Mix Claude and Cursor across the batch so the model best at each kind of task ends up on it. Come back from standup to a kanban of ready-to-review PRs.

### Operator — one prompt becomes an epic

Give an agent the orchestrator skills. It plans the work, breaks down the spec, and dispatches subtasks — each in its own worktree, mergeable independently. Inside a Claude Code window, the agent becomes the *user* of octomux. You supervise from the Orchestrator view.

## Quick start

```bash
npm install -g @anthropic-ai/claude-code    # and/or Cursor CLI
npm install -g octomux
octomux init
cd your-project
octomux start
```

`tmux` ships bundled (macOS and Linux, arm64/x64) — no separate install step.

```bash
octomux create-task -t "Add OAuth login" -r .
octomux create-task -t "Spike with Cursor" -r . --harness cursor
```

**Prefer a desktop app?** macOS users can download the `.dmg` from
[GitHub Releases](https://github.com/ShreyPaharia/octomux/releases). It bundles its own
`tmux` and runs against an isolated data directory. The build is ad-hoc signed (not
notarized) — if macOS warns on first launch, right-click the app → **Open**.

Step-by-step setup, Jira/Linear, and orchestrator skills: [ONBOARDING.md](./ONBOARDING.md)

## How it compares

A few tools now run coding agents in parallel. An honest cut of where octomux fits:

|                                        | **octomux**      | vibe-kanban       | Conductor     | Emdash          |
| -------------------------------------- | ---------------- | ----------------- | ------------- | --------------- |
| License                                | MIT, open source | MIT (community\*) | Closed        | Open source     |
| Runs fully local, no cloud             | Yes              | Now local\*       | Cloud account | Yes             |
| Kanban / fleet view                    | Yes              | Yes               | Yes           | Yes             |
| Git worktree per task                  | Yes              | Yes               | Yes           | Yes             |
| One permission inbox                   | **Yes**          | No                | No            | No              |
| Monitor grid (all agents at once)      | **Yes**          | No                | No            | No              |
| Automated review + human-gated publish | **Yes**          | Partial           | Partial       | No              |
| Recursive orchestration (agents dispatch agents) | **Yes**| No                | No            | No              |
| Reach it from your phone (tailnet)     | **Yes**          | No                | No            | Partial (SSH)   |
| Desktop app                            | Yes (macOS)      | Yes               | Yes           | Yes             |
| Claude Code + Cursor                   | Yes              | Yes (10+)         | Yes           | Yes (20+)       |
| Platform                               | macOS + Linux    | macOS/Linux/Win   | macOS only    | macOS/Linux/Win |

<sub>\* Bloop, the company behind vibe-kanban, wound down in early 2026; it continues as a community project.</sub>

The wedge: octomux is built around the *human's* job once the agents are running — the permission inbox, the fleet grid, the review workstation, the orchestrator view — as composable lenses over an open backend you can host and reach from anywhere. Local-first, no telemetry, actively maintained.

## CLI

| Command                                  | Description                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `octomux start`                          | Dashboard at `:7777` (add `--bind 0.0.0.0` for remote)                    |
| `octomux init`                           | Defaults wizard (Jira/Linear, base branch, harness prefs)                 |
| `octomux create-task`                    | New task (`--harness`, `--model`, `--mode`, `--fork-from` optional)       |
| `octomux list-tasks` / `get-task`        | Inspect tasks                                                             |
| `octomux close-task` / `delete-task`     | Stop or fully remove                                                      |
| `octomux resume-task`                    | Resume a closed task                                                      |
| `octomux add-agent`                      | Another agent window (`--model`, `--notify-agent` optional)               |
| `octomux send-message`                   | Message a running agent — course-correct without restart                  |
| `octomux team run` / `schedule` / `list` | Run or schedule an agent crew from `.octomux/team.yaml`                   |

## Remote access over Tailscale

octomux binds to `127.0.0.1` by default — reachable only from the host. To control sessions
from your phone or another laptop, put them on a [Tailscale](https://tailscale.com) tailnet
and enable remote mode:

1. Install Tailscale on the host and each device; run `tailscale up`. Enable MagicDNS.
2. Start in remote mode:
   ```bash
   octomux start --bind 0.0.0.0    # or: OCTOMUX_BIND=0.0.0.0 octomux start
   ```
   A random access token is generated on first start; its path is logged
   (`~/.octomux/data/remote-token`). Override with `OCTOMUX_REMOTE_TOKEN=<secret>`.
3. (Optional) Restrict the accepted `Host` header:
   `OCTOMUX_ALLOWED_HOSTS=mybox.your-tailnet.ts.net`. The `100.64.0.0/10` tailnet range is
   accepted automatically.
4. From a tailnet device, open `http://<host-magicdns-name>:7777` and sign in once with the
   token. Loopback access never needs it.

**Security:** only tailnet devices reach the port; the token is a second factor. For HTTPS,
front octomux with `tailscale serve`.

## FAQ

**How is this different from tmux + Claude Code?**
octomux adds the inbox, the fleet grid, the review workstation, and the orchestrator view on top. tmux is just plumbing underneath.

**Does it work with Cursor?**
Yes — pick Claude Code or Cursor per task, and mix them on one task with **Add agent**.

**What if two agents touch the same file?**
They can't — each task runs in its own git worktree on its own branch.

**Can I use it from my phone?**
Yes — host it on a tailnet box and open the mobile-ready dashboard from any device on the tailnet.

**What if my laptop reboots?**
Run `octomux start`. Tasks, branches, terminals, and review state come back.

**How do I track agent cost?**
Each agent's session log carries token usage today; a first-class cost view is on the roadmap.

## Links

- [GitHub](https://github.com/ShreyPaharia/octomux) · [npm](https://www.npmjs.com/package/octomux) · [octomux.com](https://octomux.com)

Issues and PRs welcome — the roadmap is shaped in the open.
