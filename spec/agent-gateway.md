# Agent gateway — Telegram/Slack assistant over the octomux conductor

> Phase 2 of "long-running agents that improve over time." A thin channel adapter that lets the
> owner talk to octomux's existing conductor over Telegram (first) and Slack (later): recall from
> the `agent_learnings` store, ask about work, and dispatch/monitor octomux tasks. Full design +
> the five-persona review that shaped it: the Phase-2 artifact. This spec is the buildable v1.

## Substrate (decided)

The assistant's brain is the **existing conductor** — a persistent **interactive `claude` session**
(`server/orchestrator/runner.ts` + transcript tail), which already runs on the owner's **Claude
subscription** (no SDK, no `-p`, no API key). Phase 2 does **not** rebuild it; it feeds it chat
turns and reads its transcript. (The Agent SDK / `claude -p` path was rejected — not in the plan;
`-p`/SDK would require metered API billing.)

## v1 scope

- **Telegram only** (Slack later, behind the same `ChannelAdapter`). Long-polling — no public URL.
- **Reactive chat**: message → conductor turn → reply. Proactive nudges are a fast-follow.
- **No per-action approval button** (that's v2). Streaming/rich rendering is v1.1.

## Security (v1)

1. **Owner allowlist — the one must-keep.** Default-deny, checked per message BEFORE any dispatch
   (Telegram `message.from.id`, Slack `team_id`+`user_id`). octomux treats loopback as fully
   trusted, so the adapter is a new trust boundary; the allowlist is the door.
2. **Outward tools read-only by credential — not by a gate.** Attach outward MCP servers (GitHub,
   Slack, Jira, Linear) with **read-scoped tokens** (GitHub MCP also `--read-only`, over stdio).
   Writes then can't happen — no gate to build, injection can't bypass a credential. A code gate
   at `runOrchestratorAction` would _miss_ these anyway (GitHub-MCP writes never hit octomux's
   endpoint). Outward mutations (PRs) happen inside dispatched **workers**, not the assistant.
   The assistant's only write capability is octomux's own coordination tools (`create_task`,
   `send_message`) — ungated in v1, behind the allowlist.
3. **Outbound redaction.** Telegram bot messages are not E2E and persist; scrub secret shapes
   before posting and persisting (reuse the Phase-1 `learn-lint` patterns).
4. **Recalled content is DATA, not commands** — seed the conductor's system prompt accordingly
   (`agent_learnings` is the worst indirect-injection vector: persistent, auto-recalled).

## Components (net-new, thin)

- `ChannelAdapter` — `{ id, start(onMessage), send(thread, text), sendTyping(thread) }`. Telegram
  via **grammY** (long-poll); Slack later via `@slack/bolt` (Socket Mode).
- `channel_threads(channel, thread_key → conv_id)` map + `gateway_inbound` dedup (SQLite).
- Outbound queue (per-thread serialize + retry + idempotency).
- `search_learnings` MCP read tool over `searchShared(query, {repo?})` — task-less, cross-repo,
  SHARED-lane only (recall is task-keyed today; a channel assistant has no task).
- Gateway glue: inbound → allowlist → dedup → map/create conv → conductor turn → tail reply →
  redact → render → outbound.

## Reliability P0s (mandatory — the review found real bugs in the interactive transport)

- **Liveness = "claude is alive"** (`pane_current_command`), not "tmux session exists"; drop the
  `exec $SHELL -i` fallback (else a crashed conductor runs chat text as bash).
- **Explicit turn boundary** via the transcript's `stop_hook_summary` line (a bot must know when a
  reply is done; fire on presence even if the hook errored).
- **Gateway-owned transcript tail** — decouple the tail from browser WS clients; boot rehydrate
  opens tails for live-session threads (else a phone DM with no dashboard is read by nothing).
- **Single FIFO write lock per conversation** (all writers), enabling the turn policy: debounce
  idle bursts (coalesce), interrupt-and-merge when a turn is running.

## Reuse

Conductor (no new dep) · better-sqlite3 · Phase-1 `learn-lint` regexes (redaction) · already-
connected Slack/Jira/Linear/Notion MCP servers (read-scoped) · GitHub MCP (`--read-only`). One new
dependency: **grammY**. Helper: a Telegram markdown lib for safe rendering.

## Non-goals (v1)

Slack · the per-action approval button (v2) · proactive nudges (fast-follow) · full streaming/rich
rendering (v1.1) · the conductor's supervised plan→approve→implement DAG (later upgrade).
