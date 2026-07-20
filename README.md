[![CI](https://github.com/ShreyPaharia/octomux/actions/workflows/ci.yml/badge.svg)](https://github.com/ShreyPaharia/octomux/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/octomux)](https://www.npmjs.com/package/octomux)
[![license](https://img.shields.io/github/license/ShreyPaharia/octomux)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ShreyPaharia/octomux)](https://github.com/ShreyPaharia/octomux)

# octomux

> **Coding got faster. Managing agents didn't.**

octomux is a **local dashboard for running many Claude Code and Cursor agents in parallel.** Each agent works in its own git worktree; you get **one inbox** for every "allow this tool?" prompt, a **live grid** of the whole fleet, and **in-app diff review** with a Ship button. Runs on your machine — no cloud, no telemetry, MIT.

```bash
npm install -g octomux && octomux init && cd your-repo && octomux start
```

Open **[localhost:7777](http://localhost:7777)**, describe a task, pick **Claude Code** or **Cursor**, and watch it work.

![octomux demo](assets/demo.gif)

---

## What you get

Three phases, one window — from prompt to merged PR:

- **① Dispatch** — Type a task (or paste a Jira/Linear/GitHub link, or a whole list). Each one gets its own worktree, branch, and agent. Pick the model per task.
- **② Watch** — Every agent's live terminal, the diff as it grows, and a **Monitor grid** of the whole fleet. Permission prompts land in one **inbox** instead of scattered across panes.
- **③ Review & Ship** — Diff review in the same window: mark files reviewed, leave inline comments, send them back to the agent to fix, then **Ship** to open the PR — which auto-closes the task when it merges.

Crash, reboot, close the lid — `octomux start` restores every task, branch, and session.

## Screenshots

|                                                                               |                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Home inbox + composer** — permission prompts, recent activity, dispatch bar | ![Home](assets/screenshots/dashboard-hero.png)           |
| **Command center** — kanban from backlog → done                               | ![Command center](assets/screenshots/command-center.png) |
| **Task cockpit** — agent tabs, live session, Ship, Done                       | ![Task detail](assets/screenshots/task-detail.png)       |
| **Diff review** — file tree, reviewed state, inline comments                  | ![Diff](assets/screenshots/diff-review.png)              |

## Features

Each screen is a lens over one managed agent backend:

- **Sessions inbox** — every permission prompt across every agent in one place; reply once, agents keep going. Tab title shows `(N) octomux` when something needs you.
- **Command center** — kanban across the real workflow (backlog → planned → in progress → review → PR → done), with filter-to-attention and a restore grace period on delete.
- **Monitor grid** — every running agent's terminal tiled into one live wall; spot the stuck one instantly.
- **Orchestrator view** — watch an agent that dispatches agents: the parent planning, its children coding, who's blocked — the whole tree at once.
- **Review workstation** — an agent drafts a walkthrough + inline comments (grounded against the real diff, no invented line numbers); nothing hits GitHub until you accept it, then it posts as one batched review. Reject a comment with a reason and it remembers for next time.
- **Chats, Workspaces, Skill & Agent editors** — detach a quick spike as its own session, manage the reusable worktrees behind your tasks, and author your Claude Code skills and subagents in the browser.
- **Agent teams** — reusable crews as code in `<repo>/.octomux/team.yaml`; a lead spawns workers (each with its own model) on demand or on a schedule.
- **Worktrees keep agents off each other** — five agents can edit `auth.ts` at once without conflicts on your main tree.
- **Run it anywhere** — npm CLI, a **macOS desktop app** ([`.dmg`](https://github.com/ShreyPaharia/octomux/releases)), or hosted on a box and reached from your **phone over Tailscale** (the UI is mobile-ready).
- **Local-only** — no telemetry, no cloud sync. Your `.env` stays on the host.

## Patterns

Three workflows octomux makes one-click:

- **Verifier — two agents, two opinions.** Claude wrote it; drop Cursor on the same branch for a second pass. A different model reads the diff without inheriting the first's assumptions, catching the bugs that pass type-checking but break in prod.
- **Sweep — five PRs by lunch.** Paste a Jira filter or GitHub issue list; each ticket gets its own worktree and agent. Come back from standup to a kanban of ready-to-review PRs.
- **Operator — one prompt becomes an epic.** Give an agent the orchestrator skills; it plans a spec, breaks it into subtasks, and dispatches each into its own worktree. You supervise from the Orchestrator view.

## How it compares

|                                        | **octomux**       | vibe-kanban       | Conductor     | Emdash          |
| -------------------------------------- | ----------------- | ----------------- | ------------- | --------------- |
| License                                | MIT, open source  | MIT (community\*) | Closed        | Open source     |
| Fully local, no cloud                  | Yes               | Now local\*       | Cloud account | Yes             |
| One permission inbox                   | **Yes**           | No                | No            | No              |
| Monitor grid (all agents at once)      | **Yes**           | No                | No            | No              |
| Automated review + human-gated publish | **Yes**           | Partial           | Partial       | No              |
| Recursive orchestration                | **Yes**           | No                | No            | No              |
| Reach it from your phone               | **Yes** (tailnet) | No                | No            | Partial (SSH)   |
| Claude Code + Cursor                   | Yes               | Yes (10+)         | Yes           | Yes (20+)       |
| Platform                               | macOS + Linux     | macOS/Linux/Win   | macOS only    | macOS/Linux/Win |

<sub>\* Bloop, the company behind vibe-kanban, wound down in early 2026; it continues as a community project.</sub>

## Why octomux

The editor was built around a human typing one file at a time. That's not the job anymore. The job is directing a fleet — and the hard part moved from _writing_ code to _reviewing_ it, _unblocking_ it, and _knowing what's happening_ across ten sessions.

octomux is a bet on what that surface should look like: not a chat box bolted onto a file tree, but a control deck. It handles the ugly backend of running agents and puts the human's job — the inbox, the fleet grid, the review workstation, the orchestrator — front and center. It's early and opinionated, and the roadmap is shaped in the open.

## Requirements

- macOS (arm64/x64) or Linux for the CLI; macOS for the desktop app
- Node.js 20+ · `git` (`tmux` ships bundled)
- At least one harness: **Claude Code** (`claude`) and/or **Cursor CLI** (`cursor-agent`)

<details>
<summary><b>Full CLI reference</b></summary>

| Command                                  | Description                                                |
| ---------------------------------------- | ---------------------------------------------------------- |
| `octomux start`                          | Dashboard at `:7777` (add `--bind 0.0.0.0` for remote)     |
| `octomux init`                           | Defaults wizard (Jira/Linear, base branch, harness prefs)  |
| `octomux create-task`                    | New task (`--harness`, `--model`, `--mode`, `--fork-from`) |
| `octomux list-tasks` / `get-task`        | Inspect tasks                                              |
| `octomux close-task` / `delete-task`     | Stop or fully remove                                       |
| `octomux resume-task`                    | Resume a closed task                                       |
| `octomux add-agent`                      | Another agent window (`--model`, `--notify-agent`)         |
| `octomux send-message`                   | Message a running agent — course-correct without restart   |
| `octomux team run` / `schedule` / `list` | Run or schedule an agent crew from `.octomux/team.yaml`    |

Full setup, Jira/Linear, and orchestrator skills: **[ONBOARDING.md](./ONBOARDING.md)**.

</details>

<details>
<summary><b>Remote access from your phone (Tailscale)</b></summary>

octomux binds to `127.0.0.1` by default. To reach it from another device, put them on a
[Tailscale](https://tailscale.com) tailnet and start in remote mode:

```bash
octomux start --bind 0.0.0.0     # or: OCTOMUX_BIND=0.0.0.0 octomux start
```

A random access token is generated on first start (path logged to
`~/.octomux/data/remote-token`; override with `OCTOMUX_REMOTE_TOKEN`). Open
`http://<host-magicdns-name>:7777` from a tailnet device and sign in once. Only tailnet
devices can reach the port; the token is a second factor. For HTTPS, front it with
`tailscale serve`.

</details>

<details>
<summary><b>Built to extend</b></summary>

octomux keeps a clean line between the **agent backend** (done for you) and the **views**
(where the value is). Building blocks available today:

- **REST API** (~110 endpoints) over tasks, agents, diffs, reviews, chats, workspaces, skills.
- **Two live WebSocket channels** — `/ws/events` for task/chat/review events, `/ws/terminal/*` for bidirectional xterm ↔ tmux.
- **A queryable SQLite schema** — tasks, agents, permission prompts, review runs, comments, learnings.
- **A pluggable harness interface** — add a new agent backend by implementing one interface and registering it.
- **User hook scripts** — drop executables in `~/.octomux/hooks` to fire on task-lifecycle events.

There isn't a drop-in plugin API for custom UI views yet — adding one means building against
these blocks in the codebase. A first-class way to author and share views is the direction
we're building toward; if that's what you want, [open an issue](https://github.com/ShreyPaharia/octomux/issues).

</details>

## FAQ

**How is this different from tmux + Claude Code?** octomux adds the inbox, the fleet grid, the review workstation, and the orchestrator view on top. tmux is plumbing underneath.

**What if two agents touch the same file?** They can't — each task runs in its own git worktree on its own branch.

**Can I use it from my phone?** Yes — host it on a tailnet box and open the mobile-ready dashboard from any device on the tailnet.

**What if my laptop reboots?** Run `octomux start`; tasks, branches, terminals, and review state come back.

## Contributing

Issues and PRs are welcome — the roadmap is shaped in the open.

```bash
git clone https://github.com/ShreyPaharia/octomux && cd octomux
bun install
bun run dev        # Express :7777 + Vite
bun run test       # vitest
```

Then open a PR **against `next`** with a short description of the change. See
**[CONTRIBUTING.md](./CONTRIBUTING.md)** for architecture and testing patterns, and
[good first issues](https://github.com/ShreyPaharia/octomux/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
to get started. We try to respond to PRs within a couple of days.

## Star it

If octomux saves you an afternoon of babysitting agents, a ⭐ helps other people find it — and tells me which parts to build next. Thanks for trying it.

## Links

[GitHub](https://github.com/ShreyPaharia/octomux) · [npm](https://www.npmjs.com/package/octomux) · [octomux.com](https://octomux.com) · [Releases](https://github.com/ShreyPaharia/octomux/releases)
