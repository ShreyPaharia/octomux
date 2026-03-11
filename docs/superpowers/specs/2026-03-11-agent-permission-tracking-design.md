# Agent Permission Prompt Tracking

Track when Claude Code agents hit permission prompts, display them globally on the tasks list,
and provide real-time agent status (active/idle/waiting) via Claude Code HTTP hooks.

## Problem

Agents running in octomux get blocked by permission prompts (e.g., "Allow Bash?") and the user
has no way to know without clicking into each task's terminal. An agent can sit blocked for
20+ minutes unnoticed, killing the fire-and-forget workflow.

## Solution

Use Claude Code's HTTP hook system to receive real-time events from agents. Three hooks:

1. **`PermissionRequest`** — fires when a permission dialog appears. Stores the event and
   marks the agent as `waiting`. Returns empty 200 (no decision), so Claude Code shows the
   native permission dialog to the user as normal.
2. **`PostToolUse`** — fires after a tool completes. Resolves the oldest pending permission
   for that agent and marks the agent as `active`.
3. **`Stop`** — fires when the agent finishes responding. Marks the agent as `idle`
   and resolves all pending permissions for that session.

Pending permission prompts are displayed inline on task cards in the global tasks list.
Resolved prompts disappear immediately. Clicking a prompt navigates to the task detail page
with the correct agent terminal selected.

## Hook Installation

When `startTask()` creates a worktree, generate `.claude/settings.local.json` in the worktree
with HTTP hooks pointing to the Express server.

The hook JSON follows Claude Code's matcher-group structure: each event maps to an array of
matcher groups, each containing a `hooks` array of handlers. Since we match all tool names,
the `matcher` field is omitted.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:7777/api/hooks/permission-request",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:7777/api/hooks/post-tool-use",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:7777/api/hooks/stop",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Note on sync vs async: All three hooks use HTTP type. HTTP hooks in Claude Code are
non-blocking for errors (non-2xx, connection failures, timeouts all allow execution to
continue). `PermissionRequest` returning an empty 200 body means "no decision" — Claude Code
shows the native permission dialog as normal. The 5s timeout prevents blocking the agent if
the octomux server is slow.

The existing `startTask()` already copies `.claude/settings.local.json` if it exists in the
source repo. The new behavior: always generate/merge hook config into the worktree's
`.claude/settings.local.json`, preserving any existing settings from the source repo.

## Data Model

### New table: `permission_prompts`

```sql
CREATE TABLE IF NOT EXISTS permission_prompts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_task_id ON permission_prompts(task_id);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_status ON permission_prompts(status);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status ON permission_prompts(agent_id, status);
```

`tool_input` is stored as a JSON string (`JSON.stringify()` on insert, `JSON.parse()` on read).

### Modified table: `agents`

Add `hook_activity` column to track real-time agent state from hooks. Named `hook_activity`
(not `activity`) to avoid confusion with the existing `status` column which tracks lifecycle
state managed by task-runner.

Migration (follows existing pattern in `initDb()` using `pragma('table_info(agents)')`):

```typescript
const agentCols = instance.pragma('table_info(agents)') as Array<{ name: string }>;
const agentColNames = agentCols.map((c) => c.name);
if (!agentColNames.includes('hook_activity')) {
  instance.exec("ALTER TABLE agents ADD COLUMN hook_activity TEXT NOT NULL DEFAULT 'active'");
  instance.exec('ALTER TABLE agents ADD COLUMN hook_activity_updated_at TEXT');
}
```

Note: SQLite does not support CHECK constraints in ALTER TABLE ADD COLUMN. Validation of
`hook_activity` values (`active` | `idle` | `waiting`) is enforced at the application level.

### Startup cleanup

In `initDb()`, after migrations, resolve all stale pending prompts:

```typescript
instance.exec(
  `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
   WHERE status = 'pending'`
);
```

## TypeScript Types

```typescript
// In server/types.ts

export type HookActivity = 'active' | 'idle' | 'waiting';

export interface Agent {
  // ... existing fields
  hook_activity: HookActivity;
  hook_activity_updated_at: string | null;
}

export interface PermissionPrompt {
  id: string;
  task_id: string;
  agent_id: string | null;
  agent_label: string; // joined from agents table
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

export interface Task {
  // ... existing fields
  pending_prompts: PermissionPrompt[];
}
```

## API Routes

### Hook endpoints (called by Claude Code)

All hook endpoints receive JSON from Claude Code on the request body. They correlate
`session_id` from the hook payload to an agent via `agents.claude_session_id`.

All hook handlers use a SQLite transaction (`.transaction()`) to ensure atomicity of the
lookup + insert/update sequence, preventing race conditions from near-simultaneous hook events.

**`POST /api/hooks/permission-request`**

Input (from Claude Code):
```json
{
  "session_id": "abc123",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf dist" },
  "permission_suggestions": [...]
}
```

Behavior:
1. Look up agent by `session_id` → `agents.claude_session_id`
2. If not found, return 200 and do nothing (agent may have been stopped/deleted)
3. Insert row into `permission_prompts` (status: pending, tool_input: JSON.stringify)
4. Update `agents.hook_activity = 'waiting'`, `hook_activity_updated_at = now()`
5. Return 200 with empty body (no decision — Claude Code shows native dialog)

**`POST /api/hooks/post-tool-use`**

Input (from Claude Code):
```json
{
  "session_id": "abc123",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf dist" }
}
```

Behavior:
1. Look up agent by `session_id`
2. Resolve the **oldest** pending `permission_prompt` for this agent (FIFO order by
   `created_at ASC LIMIT 1`). Uses agent_id, not tool_name, to avoid mismatches when
   the same tool fires PostToolUse without a preceding permission.
3. Update `agents.hook_activity = 'active'`, `hook_activity_updated_at = now()`
4. Return 200

Note: FIFO resolution is used because Claude Code can only execute a tool after its
permission is granted, so the oldest pending prompt is always the one being resolved.
PostToolUse fires on every tool completion, not just after permission grants — if there are
no pending prompts, step 2 is a no-op and only the activity update in step 3 runs.

**`POST /api/hooks/stop`**

Input (from Claude Code):
```json
{
  "session_id": "abc123",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

Behavior:
1. Look up agent by `session_id`
2. Resolve ALL pending `permission_prompts` for this agent
3. Update `agents.hook_activity = 'idle'`, `hook_activity_updated_at = now()`
4. Return 200

### Query endpoints (called by frontend)

**`GET /api/tasks`** — existing endpoint, response now includes:
- `agents[].hook_activity` field on each agent object
- `pending_prompts[]` array per task (only status='pending', not resolved)

The query joins `permission_prompts` on `task_id` where `status = 'pending'` and joins
`agents` to get `agent.label` for display.

Each prompt object in the response:
```json
{
  "id": "abc123",
  "agent_id": "def456",
  "agent_label": "Agent 1",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf dist" },
  "created_at": "2026-03-11T10:30:00Z"
}
```

**`GET /api/tasks/:id`** — same additions as above for single task view.

## Frontend

### Tasks list page — task cards

When a task has pending permission prompts, show them inline below the task metadata:

```
┌─ Add auth ────── [running] ──── PR #12 ──────────────┐
│                                                       │
│  Agent 1  ● active     Agent 2  ○ idle                │
│                                                       │
│  ⚠ Agent 1 · Bash "rm -rf dist"           2m ago     │
│  ⚠ Agent 1 · Edit server/api.ts           30s ago    │
│    click to open terminal →                           │
└───────────────────────────────────────────────────────┘

┌─ Fix bug ─────── [running] ──────────────────────────┐
│                                                       │
│  Agent 1  ● active                                    │
│                                                       │
└───────────────────────────────────────────────────────┘
```

- Warning icon + amber color for pending prompts
- Show agent label, tool name, abbreviated tool input, relative timestamp
- Clicking a prompt row navigates to `/tasks/:id?agent=:agentId`
- When there are no pending prompts, the section is hidden (not an empty state)
- Agent activity indicators: green dot = active, gray dot = idle, amber dot = waiting

### Task detail page

- Agent tabs show activity indicator (colored dot) matching the hook_activity state
- No separate permissions panel — prompts are on the global view, terminal is here

### Polling

The existing `useTasks()` hook polls every 5 seconds. The pending prompts and agent activity
data rides on the same `/api/tasks` response. No new polling mechanism needed.

## Hook-to-Agent Correlation

Claude Code hooks include `session_id` which is the Claude session identifier. We already
store `claude_session_id` on each agent record (set at spawn time in `startTask` and
`addAgent`). Correlation:

```
hook.session_id → agents.claude_session_id → agent.id → agent.task_id
```

If no agent matches (e.g., agent was deleted), the hook endpoint returns 200 and does nothing.

### Session ID on resume

When a task is resumed via `resumeTask()`, agents launched with `--resume <session_id>` reuse
the same Claude session ID, so hooks from the resumed session correlate correctly. Agents
launched with `--continue` (fallback, when `claude_session_id` is null) currently do NOT get a
tracked session ID. Fix: generate a new UUID, pass `--session-id <uuid>` alongside
`--continue`, and update `claude_session_id` in the DB. This ensures hooks from `--continue`
agents are also tracked.

## Edge Cases

1. **Agent stopped while permission pending** — `stopAgent()` in task-runner should resolve
   all pending prompts for that agent (in addition to existing cleanup).

2. **Task deleted** — CASCADE delete handles this. The manual `DELETE FROM agents` in api.ts
   triggers cascade on `permission_prompts.agent_id`, and the subsequent task deletion
   triggers cascade on `permission_prompts.task_id`.

3. **Task closed** — `closeTask()` should resolve all pending prompts for all agents in the
   task. Run the resolution query BEFORE updating agents to `stopped` status.

4. **Server restart** — On startup in `initDb()`, mark all `pending` prompts as `resolved`.
   Hooks will re-fire if agents are still waiting after task recovery.

5. **Hook arrives before agent record exists** — Possible during `startTask()` if Claude
   starts fast. The 3s `CLAUDE_INIT_DELAY` provides buffer. If still no match, return 200
   and ignore.

6. **Existing `.claude/settings.local.json` in source repo** — Read existing file,
   deep-merge hooks object: for each event key, append our matcher group object to the
   event's array (don't modify existing matcher groups), write back.

7. **Multiple pending prompts per agent** — Possible if agent hits multiple permission
   prompts in quick succession. Show all of them. FIFO resolution ensures correct ordering.

8. **Concurrent hook requests** — Near-simultaneous PermissionRequest and PostToolUse for the
   same agent. SQLite transactions ensure atomicity. better-sqlite3 is synchronous so writes
   are serialized, but Express handlers are async — the transaction boundary prevents
   interleaved read-modify-write.

9. **Orphaned prompts with null agent_id** — If a PermissionRequest arrives before the agent
   record exists (edge case 5), it's stored with `agent_id = NULL`. These won't be resolved
   by PostToolUse (which queries by agent_id), but will be cleaned up by Stop hook or on
   server restart.

## Testing

- **Hook endpoint tests** — supertest against `createApp()`, POST to each hook endpoint with
  mock payloads, verify DB state after each call
- **DB migration tests** — verify `permission_prompts` table and `hook_activity` column exist
  after `initDb()` with `createTestDb()`
- **Task-runner integration** — `closeTask()` and `stopAgent()` resolve pending prompts
- **Frontend component tests** — TaskCard renders pending prompts, activity dots, click
  navigation
- **Test helpers** — add `DEFAULTS.permissionPrompt` fixture and `insertPermissionPrompt()`
  to `server/test-helpers.ts`

## Out of Scope (Phase 2)

- Remote approve/deny from the dashboard (PermissionRequest hook can return decisions)
- Permission analytics (which tools get prompted most, per-repo patterns)
- Allow-list suggestions based on prompt patterns
- Sound/desktop notifications for permission prompts
