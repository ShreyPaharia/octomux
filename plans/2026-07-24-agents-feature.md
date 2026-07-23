# Agents feature — Implementation Plan

> **For agentic workers:** implement task-by-task. Each task lists exact files, the interface it
> produces/consumes, and an independently testable deliverable. Mirror existing neighbours — do not
> invent patterns. Run `bun run test <files>` + `bun run typecheck` per task.

**Goal:** A first-class **Agents** surface — create long-running agents (name + system prompt +
channel binding), see them as status cards, open one to configure it or watch its live conductor
session; each agent has the full orchestrator toolset and hears back from worker subagents.

**Architecture:** Reuse the conductor runtime (tmux/claude/transcript + MCP tools + gateway). Add an
`agents` config table; an agent's session is an `orchestrator_conversations` row tagged with
`agent_id`, launched with the agent's system prompt. The existing orchestrator page and its
`agent_id = NULL` conversations are untouched. Spec: `spec/agents-feature.md`.

**Tech Stack:** Express 5 + better-sqlite3, React 19 + React Router 7 + Tailwind/shadcn, vitest.

## ⚠️ Naming correction (discovered during Task 1 — applies to ALL later tasks)

A table named `agents` **already exists** (per-task tmux-window workers, `repositories/agent-runtime.ts`).
The new config table is therefore **`agent_configs`**, and `orchestrator_conversations.agent_id`
references `agent_configs(id)`. `agent-runtime.ts` also already exports `getAgent`, so:

- Import agent-config functions **directly**: `from '../repositories/agents-config.js'`
  (`createAgent`, `getAgent`, `listAgents`, `updateAgent`, `deleteAgent`, `getAgentByChannel`), **or**
- use the barrel alias `getAgentConfig` from `repositories/index.js` (only the colliding `getAgent`
  is aliased; everything else passes through unaliased).

`getAgentByChannel(channel, threadKey)`: `channel_config` is JSON `{ threadKey?: string }`. An agent
with no `threadKey` binds to the whole channel; a specific `threadKey` match wins over channel-wide.

**Route namespace (discovered during Task 4):** `/api/agents` is ALSO already taken
(`routes/agent-defs.ts` = agent role definitions; `routes/chats.ts` = `PATCH /api/agents/:id/task`).
Mounting there silently shadows them. The new CRUD is therefore at **`/api/agent-configs`**:

- `GET|POST /api/agent-configs`, `GET|PATCH|DELETE /api/agent-configs/:id`
- `POST /api/agent-configs/:id/session` → ensures + returns the agent's persistent conversation
- Exported from `routes/agents-crud.ts`: `type AgentStatus = 'stopped'|'idle'|'working'`,
  `deriveAgentStatus(agentId): Promise<{ status: AgentStatus; session_id: string|null }>`,
  and the `AgentWithStatus` response type.
- `isConversationSessionAlive(conv)` is now exported from `orchestrator/runner.ts` — reuse it.

**Frontend must call `/api/agent-configs`, NOT `/api/agents`.**

## Global Constraints

- **Do NOT modify `src/pages/OrchestratorPage.tsx` or orchestrator behaviour.** Agents is a separate
  surface; the orchestrator stays intact.
- DB migrations are **forward-only**; append to `server/db/migrations.ts`.
- All server logs via `childLogger`; every agent/session line includes ids.
- Conventional commits; no `Co-Authored-By`. Do not commit unless told.
- Reuse liveness (`isConversationSessionAlive`-style) and `get_agent_output` primitives — do not
  reinvent tmux probing.

---

### Task 1: DB migration — `agents` table + `agent_id` on conversations

**Files:** Modify `server/db/migrations.ts` (append), `server/db/schema.ts` (if new-DB schema lives
there — check; else migration only). Test: `server/db.test.ts` or a new migration test.

**Produces:** table `agents(id TEXT PK, name TEXT, system_prompt TEXT, channel TEXT NULL,
channel_config TEXT NULL, created_at TEXT, updated_at TEXT)`; column
`orchestrator_conversations.agent_id TEXT NULL`.

- [ ] Append a migration creating `agents` and `ALTER TABLE orchestrator_conversations ADD COLUMN
agent_id TEXT` (guard with the existing "column exists?" helper pattern already used in this file).
- [ ] Add matching `CREATE TABLE`/column to `schema.ts` if that's where fresh DBs are built (mirror
      how `channel_threads` was added).
- [ ] Test: fresh `createTestDb()` has an `agents` table and `orchestrator_conversations.agent_id`.
- [ ] Run `bun run test server/db.test.ts` + typecheck. Commit `feat(db): agents table + conversation agent_id`.

---

### Task 2: `agents` repository (CRUD)

**Files:** Create `server/repositories/agents-config.ts`; export from `server/repositories/index.ts`.
Test: `server/repositories/agents-config.test.ts`.

**Consumes:** Task 1 schema. **Produces:**

```ts
export interface AgentConfig {
  id: string;
  name: string;
  system_prompt: string;
  channel: string | null;
  channel_config: string | null;
  created_at: string;
  updated_at: string;
}
export function createAgent(input: {
  name: string;
  system_prompt: string;
  channel?: string | null;
  channel_config?: string | null;
}): string; // nanoid(12)
export function getAgent(id: string): AgentConfig | undefined;
export function listAgents(): AgentConfig[];
export function updateAgent(
  id: string,
  patch: Partial<Pick<AgentConfig, 'name' | 'system_prompt' | 'channel' | 'channel_config'>>,
): void;
export function deleteAgent(id: string): void;
export function getAgentByChannel(channel: string, threadKey: string): AgentConfig | undefined; // matches channel + channel_config thread binding
```

- [ ] TDD each function against `createTestDb()`; `updated_at` bumps on update (template-literal `datetime('now')`).
- [ ] Run tests + typecheck. Commit `feat(agents): agents-config repository`.

---

### Task 3: Per-agent system prompt in the conductor launch

**Files:** Modify `server/orchestrator/conductor-flags.ts` (accept an optional `systemPrompt`),
`server/orchestrator/runner.ts` (`startConversation`/`resumeConversation` opts thread it through).
Tests: extend `server/orchestrator/conductor-flags.test.ts`, `runner.test.ts`.

**Consumes:** none. **Produces:** `buildOrchestratorConductorFlags({ ..., systemPrompt?: string })`
uses the given prompt (default = existing `ORCHESTRATOR_SYSTEM_PROMPT`). `StartConversationOpts`
gains `systemPrompt?: string`; when the conversation has an `agent_id`, the caller passes the
agent's `system_prompt`.

- [ ] Failing test: flags include a custom `--append-system-prompt` when `systemPrompt` given.
- [ ] Implement (default unchanged so orchestrator conversations are byte-identical).
- [ ] Full suite (touches the runner) + typecheck. Commit `feat(orchestrator): per-conversation system prompt`.

---

### Task 4: `/api/agents` CRUD + derived status

**Files:** Create `server/routes/agents-crud.ts`; mount in `server/api.ts` (shared — one-line add).
Also `server/orchestrator/store.ts`: add `listConversationsByAgent(agentId)` /
`getPrimaryAgentConversation(agentId)`. Test: `server/api.agents.test.ts` (supertest against `createApp()`).

**Consumes:** Tasks 2, 3. **Produces:** REST:

- `GET /api/agents` → `[{...AgentConfig, status: 'working'|'idle'|'stopped', session_id: string|null }]`
- `POST /api/agents` `{name, system_prompt, channel?, channel_config?}` → `{id}` (creates the agent;
  lazily starts its one session on first message rather than here).
- `GET /api/agents/:id`, `PATCH /api/agents/:id`, `DELETE /api/agents/:id` (delete stops its session).
- `POST /api/agents/:id/session` → ensure/return the agent's persistent conversation (starts one
  via `startConversation` with the agent's prompt + `agent_id`).

Status derivation: find the agent's conversation; `stopped` if none/tmux gone; else reuse the
liveness probe — `working` if pane shows claude actively generating (approx: no idle prompt) else
`idle`. Keep it a lean helper; don't block the list on many tmux calls (cap/parallelise).

- [ ] TDD the routes (create → list shows it; delete removes; status shape).
- [ ] Full suite + typecheck. Commit `feat(agents): CRUD API + status`.

---

### Task 5: Gateway — bind a channel thread to an agent's session

**Files:** Modify `server/gateway/gateway.ts` (in `ensureThread`, if the channel/thread resolves to
an agent via `getAgentByChannel`, use that agent's persistent conversation + system prompt instead
of creating a throwaway). Test: extend `server/gateway/gateway.test.ts`.

**Consumes:** Tasks 2, 3, 4 (`getPrimaryAgentConversation`, `startConversation({agentId, systemPrompt})`).
**Produces:** inbound on a bound channel → the agent's persistent session; unbound channel → today's
behaviour (unchanged). One session per agent (reused across messages/restarts).

- [ ] Failing test: an inbound telegram msg whose (channel, threadKey) matches an agent binding
      dispatches to that agent's conversation (assert conv reused, agent's prompt used).
- [ ] Implement; keep the existing non-agent path intact.
- [ ] `bun run test server/gateway/` + typecheck. Commit `feat(gateway): route bound channels to their agent session`.

---

### Task 6: Replace worker `report_complete` with `send_message` to the owner

**Files:** Modify `server/orchestrator/mcp/write.ts` (drop `report_complete`/`callPhaseComplete`
worker path OR make it delegate to send_message to the owning conversation), `server/orchestrator/mcp/server.ts`
(tool registration), `server/orchestrator/command-registry.ts` (+ test), and the worker-launch
MCP-config that enabled `report_complete`. Tests: `write` + `command-registry` + a routing test.

**Consumes:** the managed_task `conversation_id` (owner). **Produces:** a worker that finishes/needs
review calls `send_message` (or an internal equivalent) whose text + artifact link is delivered to
the **owning agent's conversation** so the session AND any bound channel receive it (verify it flows
through the transcript/gateway path, not only `pushToConversation`). For agent-dispatched tasks, **no
approval cards** — a message with the artifact URL (`/api/orchestrator/artifact?task=…&path=…`).
Keep the orchestrator page's own managed-task card flow working (only change the worker→owner report path).

- [ ] Failing test: worker report on task owned by conv X results in a message delivered to conv X
      that a gateway consumer would see (not WS-only).
- [ ] Implement. Full suite + typecheck. Commit `fix(orchestrator): worker reports reach the owning agent via send_message`.

---

### Task 7: API client for agents (frontend data layer)

**Files:** `src/lib/api.ts` (add `agentsApi`: list/create/get/update/delete/ensureSession) mirroring
`orchestratorApi`. Test: extend the api client test if one exists, else a light unit test.

**Consumes:** Task 4 REST. **Produces:** typed `agentsApi` used by Tasks 8–9.

- [ ] Add typed methods + types; typecheck. Commit `feat(agents): frontend api client`.

---

### Task 8: Agents page — status cards

**Files:** Create `src/pages/AgentsPage.tsx` + `src/pages/AgentsPage.test.tsx`. Uses `agentsApi.list`.

**Consumes:** Task 7. **Produces:** `/agents` — a grid of agent **cards** (name, status pill
working/idle/stopped, channel badge, last activity) + a "New agent" dialog (name, system prompt,
channel + allow-list). Card click → `/agents/:id`. Follow `TasksPage`/`LoopsPage` card patterns +
`makeTask`-style test helpers.

- [ ] Component test: renders cards from mocked api; create dialog posts; empty state.
- [ ] `bun run test src/pages/AgentsPage.test.tsx` + typecheck. Commit `feat(agents): agents cards page`.

---

### Task 9: Agent detail — Config + Sessions (chat) tabs

**Files:** Create `src/pages/AgentDetailPage.tsx`, `src/components/AgentSessionChat.tsx` (+ tests).
**Do not import from OrchestratorPage** — build the chat from the same lower-level pieces it uses
(the orchestrator WS endpoint/hook, message list, send box). If a reusable chat hook/component
doesn't exist yet, create `AgentSessionChat` standalone (may mirror OrchestratorPage internals, but
as new files).

**Consumes:** Task 7. **Produces:** `/agents/:id` with two tabs:

- **Config** — edit name/system_prompt/channel(+allow-list); Save (PATCH), Delete.
- **Sessions** — ensure/open the agent's session (`agentsApi.ensureSession`) and render the live
  chat/CLI (WS stream to `/ws/orchestrator/:convId`, transcript render, send box) — same behaviour
  as the orchestrator tab.
- [ ] Component tests: Config save/delete; Sessions tab mounts the chat against a mocked WS/api.
- [ ] Tests + typecheck. Commit `feat(agents): agent detail config + sessions tabs`.

---

### Task 10: Navigation + routes

**Files:** Modify `src/App.tsx` (routes `/agents`, `/agents/:id`), the nav components
(`src/components/MobileBottomNav.tsx` + the desktop sidebar/nav — find the orchestrator nav entry and
add an **Agents** entry next to it; leave orchestrator intact). Tests: extend nav tests if present.

**Consumes:** Tasks 8, 9. **Produces:** an **Agents** nav entry routing to `/agents`; orchestrator
entry unchanged.

- [ ] Add lazy routes + nav entries. Component/route smoke test.
- [ ] Full suite + typecheck + lint. Commit `feat(agents): navigation + routes`.

---

## Self-Review

- Spec coverage: agents table+status → T1,T2,T4; per-agent prompt → T3; channel trigger → T5;
  report-back fix → T6; cards page → T8; config+sessions tabs → T9; nav (orchestrator intact) → T10. ✓
- Orchestrator untouched: only T10 edits shared nav/App to ADD entries; OrchestratorPage.tsx is never
  modified (global constraint). ✓
- Shared-file bottlenecks (`migrations.ts` T1, `api.ts` T4, `index.ts` T2, `server.ts`/registry T6,
  `App.tsx`/nav T10) are each isolated to one task → safe to parallelise the rest.

## Execution / dispatch order

- **Wave 1 (sequential foundation):** T1 → T2 → T3 (T2 needs T1; T3 independent but touches runner).
- **Wave 2 (parallel, disjoint files):** T4, T5, T6 — T4 owns `api.ts`+store; T5 owns `gateway.ts`;
  T6 owns `write.ts`/`server.ts`/registry. Disjoint. (T5 consumes T4's store helper — land T4 first
  or stub the helper.)
- **Wave 3:** T7 → then parallel T8, T9 (disjoint pages) → T10 (nav, last).
