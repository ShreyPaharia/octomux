# Agents — first-class long-running agents

> A dedicated **Agents** surface: create long-running agents (name + system prompt + channel
> trigger), see them as cards with live status, and open one to configure it or watch its running
> session (a conductor CLI chat). Each agent has the full octomux orchestrator toolset and can
> dispatch, message, and hear back from worker subagents. The existing **orchestrator page is left
> untouched** — this is a separate surface built on the same conductor runtime.

## Model (decided)

- **Agent** = a config record (name, system prompt, channel binding) + **one persistent conductor
  session** — a long-running interactive `claude` in tmux, launched with the agent's system prompt
  and the octomux MCP toolset (same runtime as the orchestrator conductor; not the orchestrator's
  conversations).
- **Session** = the agent's live conductor conversation. One primary persistent session per agent;
  the Sessions tab shows it (and any prior ones).
- **Trigger (v1)** = a **channel binding**: Telegram now, Slack later. The gateway routes that
  channel's messages to the bound agent's session instead of a throwaway conversation. (No manual /
  cron / event triggers in v1.)
- **Abilities** = the full orchestrator MCP toolset (create_task, send_message, monitor, reads,
  search_learnings, get_agent_output, …) — identical to the conductor.

## Subagent communication (the report-back fix)

Bidirectional, both via `send_message`:

- **Agent → subagent**: `mcp__octomux__send_message` (exists).
- **Subagent → agent**: replace the worker `report_complete` tool with `send_message` targeted at
  the **owning agent's session**. It lands as a real message the session — and any bound channel —
  sees. This closes the bug where `report_complete` fired `task:phase_complete` and the supervisor
  delivered it via `pushToConversation` (WS/web only), which the gateway (transcript-tail only)
  never received.
- **Review gates**: for agent-dispatched tasks, no approval **cards** — the worker sends back a
  message with a **tappable artifact link** (plan/spec/diff URL via the existing
  `/api/orchestrator/artifact` endpoint); the owner approves by replying in chat/Telegram.

## Backend

- New `agents` table: `id`, `name`, `system_prompt`, `channel` (nullable: `telegram`/`slack`),
  `channel_config` (JSON: allow-list/thread key), `created_at`, `updated_at`.
- `orchestrator_conversations` gains a nullable `agent_id` FK — an agent's session is a conversation
  tagged with its `agent_id`. Orchestrator-page conversations keep `agent_id = NULL` (untouched).
- Conductor launch accepts a **custom system prompt** (today `ORCHESTRATOR_SYSTEM_PROMPT` is
  hardcoded in `conductor-flags.ts`) — the agent's prompt is used for its session.
- CRUD API under `/api/agents`: list (with derived status), create, get, patch, delete. Status is
  derived: `working` if the session's pane shows claude actively generating, else `idle`, else
  `stopped` (no live session) — reuse the liveness/`get_agent_output` primitives.
- Gateway change: when an inbound channel/thread is bound to an agent, route to that agent's
  persistent session; otherwise fall back to today's behavior.
- Replace `report_complete` registration/handler with `send_message` back to the owning
  conversation; drop the `phase_complete`→card choreography for agent-dispatched tasks (keep it for
  the orchestrator page's own managed tasks so that surface is unchanged).

## Frontend (all new; orchestrator page unchanged)

- `/agents` — **cards**: name, status pill (working/idle/stopped), channel badge, last-activity,
  quick actions (open, stop). A "New agent" action.
- `/agents/:id` — two tabs:
  - **Config** — edit name, system prompt, channel binding (+ allow-list). Save/delete.
  - **Sessions** — the live session as a **chat/CLI view** with the same behavior as the
    orchestrator tab, built from shared chat components (WS stream, transcript render, send box).
- Nav: add an **Agents** entry. The orchestrator entry stays as-is (kept aside, not removed).

## Reuse vs new

- **Reuse (runtime):** the conductor runner (tmux/claude/transcript), the MCP tools, the gateway,
  the artifact endpoint, liveness + `get_agent_output`, and the chat WS/render **components**.
- **New (surface + config):** the `agents` table + CRUD, `agent_id` on conversations, per-agent
  system prompt, the `/agents` cards page and detail tabs, the channel→agent binding, and the
  `report_complete`→`send_message` swap.

## Non-goals (v1)

Manual/cron/event triggers · multiple concurrent sessions per agent · approval cards for
agent-dispatched tasks · touching or migrating the existing orchestrator page · Slack transport
(the binding shape is there; the Slack adapter itself is a later fast-follow).
