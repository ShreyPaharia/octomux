# octomux — competitor cheat-sheet (internal, for answering HN/X comments)

NOT for posting. This is to answer "isn't this just X?" fast and accurately.
Facts verified June 2026 from public docs/repos — re-check before quoting, this
space moves weekly.

## One-line positioning

Most tools nail _spawning_ parallel agents. octomux spends its complexity on the
_workflow around the code_ — tracker status sync, in-app review with inline
comments, agents that message/spawn each other — and stays harness-agnostic
(Claude **or** Cursor) and fully local/MIT. The git-vs-GitHub split: the agent is
the engine, octomux is the manage/review/ship layer.

## What's genuinely distinctive (lead with these)

1. **Automatic tracker status sync.** Agent flips task to Human review → PR →
   Done and pushes that to Jira (Linear too, if shipped). **No competitor below
   ships this** — Vibe Kanban has it only as an open proposal (issue #2424).
   This is the strongest single differentiator.
2. **Agent-to-agent messaging + recursive dispatch in the dashboard**
   (`/send-agent-message`, `/create-task`, `/list-tasks`). Closest overlap is
   Claude Code's "Agent Teams" — but that's CLI-only, not in the desktop app,
   and Claude-only.
3. **The full stack in one open package:** kanban + inbox + in-app diff review +
   tracker sync + cross-vendor + local + MIT. No single competitor has all of it.

## What is NOT unique (don't claim it is)

- **In-app diff review** — Vibe Kanban and Conductor both have it. octomux's edge
  is depth (inline comments, walkthrough, grouped files, reviewed-state), not
  existence.
- **Kanban board** — Vibe Kanban and Crystal/Nimbalyst have boards too.
- **Cross-vendor (Claude + Cursor)** — Vibe Kanban and Claude Squad are also
  multi-agent. (Conductor = Claude+OpenAI; Claude Code native = Claude only.)
- **Worktree-per-task isolation** — table stakes; everyone does it.
- **Reboot/resume** — Crystal and Claude Squad (via tmux) also persist sessions.

## Per-competitor notes

### Vibe Kanban (BloopAI) — the closest comparison

- OSS, **cross-platform**, multi-agent (Claude, Cursor, Copilot, Gemini),
  worktrees, kanban (To Do→In Progress→Review→Done), in-app code review, MCP
  client, auto GitHub PR.
- **Gaps vs octomux:** Jira/tracker sync is a _proposal only_, not shipped. No
  agent-to-agent messaging noted.
- **Context:** Bloop (the company) announced shutdown early 2026; now
  community-maintained OSS. Fair, non-snarky framing: "Vibe Kanban is the closest
  thing and it's good; the company wound down so it's community-run now, and the
  tracker-sync/agent-messaging pieces are where we go further."
- It has a real installed base — don't imply it's dead or worse across the board.

### Conductor (Melty Labs)

- Free, **closed-source native Mac app** (Apple Silicon only), Claude + OpenAI,
  parallel threads, auto worktrees, diff review, merge in one place. Polished UX.
- **Gaps vs octomux:** not open source, no tracker integration, Claude+OpenAI
  (no Cursor), Mac-only like us.
- Framing: "Conductor's a slick native app; we're open, cross-vendor, and built
  around the tracker/review workflow rather than just the parallel runner."

### Crystal → Nimbalyst (stravu)

- Crystal deprecated Feb 2026 → Nimbalyst. OSS desktop, Codex + Claude, worktrees,
  session resume w/ history, integrated git (rebase/squash/diff). Nimbalyst adds
  visual editors (markdown, Excalidraw, mockups).
- **Gaps vs octomux:** no tracker sync / auto status, no agent messaging noted;
  different bet (visual editing surface vs workflow/tracker layer).

### Claude Squad

- OSS **terminal TUI**, tmux + worktrees, many agents (Claude, Codex, Gemini,
  Aider, OpenCode, Amp), session persistence.
- **Gaps vs octomux:** terminal-only — no GUI kanban, no visual diff review, no
  tracker integration. It's lighter-weight plumbing; we're the GUI workflow layer.

### Claude Code native (desktop redesign, Apr 2026) — the elephant

- Session sidebar, parallel sessions, auto worktrees, integrated terminal/editor,
  pane layout. Agent Teams (agents messaging each other) = **CLI only, not
  desktop**. Dynamic workflows in desktop. macOS + Windows. **Claude-only.**
  Pro/Max/Team/Enterprise.
- **Gaps vs octomux:** Claude-only (no Cursor), no kanban fleet board, no tracker
  status sync, agent-teams messaging not in the GUI.
- Best framing (be humble here): "If Claude Code's built-in sessions cover your
  workflow, you may not need octomux. We add the cross-vendor board, the tracker
  sync, and the review layer on top — and we don't try to out-build the harness."

## Honest limitations of octomux (say these yourself before someone else does)

- **macOS only** today (same as Conductor; Claude native is Mac+Windows).
- **Single-user / local** — no hosted team dashboard or shared cloud view.
- Leans on **tmux + git worktrees** under the hood (a dependency, and an opinion).
- **No first-class cost/usage view yet** — per-session token logs exist; dashboard
  view is on the roadmap (per README).
- Younger and smaller community than Vibe Kanban's installed base.

## Comment-handling reminders (from HN launch norms)

- Agree with the kernel of truth before answering an objection.
- Never say "fastest/best/first." Let the specifics speak.
- Don't have friends post booster comments — HN detects and punishes it.
- Treat "isn't this X?" as a real question, answer with the 1–2 specifics above,
  and concede where a competitor is genuinely better.
