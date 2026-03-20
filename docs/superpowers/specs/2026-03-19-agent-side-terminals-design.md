# Agent-Side Terminals Design

## Problem

When monitoring agents in the octomux dashboard, users frequently need to interact with the same worktree — running tests, checking git status, inspecting files, or debugging. Currently they must manually tmux-attach or navigate to the worktree in a separate terminal outside the dashboard.

## Solution

Add the ability to create multiple user shell terminals per task, displayed as tabs alongside agent tabs in the same tab bar, sharing one terminal viewport.

## Design Decisions

- **Multiple user terminals per task** — users can open as many shell tabs as needed
- **Side-by-side tabs** — agent tabs and user terminal tabs share one tab bar and one viewport; clicking any tab shows that terminal
- **New tmux windows in existing session** — reuses the exact same infrastructure agents use (tmux window + node-pty + WebSocket + xterm.js)
- **Editor toggle stays separate** — the existing nvim Editor feature is unchanged
- **Ephemeral terminals** — user terminals are destroyed on task close, not recreated on resume
- **Two `+` buttons** — agent `+` (with `...` for prompt dialog) stays after agent tabs; terminal `+` after terminal tabs, separated by a visual divider

## Data Model

New `user_terminals` table:

```sql
CREATE TABLE IF NOT EXISTS user_terminals (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    window_index INTEGER NOT NULL,
    label        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'idle',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_terminals_task ON user_terminals(task_id);
```

Each row represents one user shell terminal = one tmux window. Labels auto-increment: "Terminal 1", "Terminal 2", etc. The `status` field is `'idle'` or `'working'`, updated by the status poller. The existing `user_window_index` column on `tasks` is unaffected (used by the Editor feature).

## Backend API

### Endpoint Naming

The existing `POST /api/tasks/:id/user-terminal` (singular, no sub-ID) is kept as-is for the Editor feature (creates a single nvim window, stores index in `tasks.user_window_index`). The new endpoints use `/terminals` (plural, with sub-IDs) for shell terminals — a distinct namespace to avoid confusion.

### New Endpoints

**`POST /api/tasks/:id/terminals`** — Create a user terminal
- Validates task is running and has a tmux session
- Creates a new tmux window: `tmux new-window -t <session> -c <worktree>`
- Waits for shell ready (reuses `waitForShellReady()`)
- No command sent — opens a plain shell
- Determines label via `COUNT(*) + 1` of existing `user_terminals` for the task (simple, allows label reuse after deletion — acceptable since labels are cosmetic)
- Inserts row into `user_terminals`
- Broadcasts `task:updated`
- Returns `{ id, task_id, window_index, label, created_at }`

**`DELETE /api/tasks/:id/terminals/:terminalId`** — Close a user terminal
- Kills the tmux window: `tmux kill-window -t <session>:<window_index>`
- Deletes the row from `user_terminals`
- Broadcasts `task:updated`
- Returns 204

### Lifecycle Hooks (existing functions)

- **`closeTask()`** — delete all `user_terminals` rows for the task (tmux session kill handles the actual windows)
- **`deleteTask()`** — CASCADE on FK handles cleanup automatically
- **`resumeTask()`** — delete all `user_terminals` rows alongside the existing `user_window_index = NULL` reset (same location in task-runner.ts)
- **All task-returning endpoints** — include `user_terminals` array in every response that returns a task object (GET list, GET single, POST create, PATCH update, POST start, POST add-agent, DELETE stop-agent). This ensures the frontend tab bar stays in sync after any mutation.

### New Types

```typescript
export type UserTerminalStatus = 'idle' | 'working';

export interface UserTerminal {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: UserTerminalStatus;
  created_at: string;
}
```

Add `user_terminals?: UserTerminal[]` to the `Task` interface.

## Activity Tracking

User terminal activity is tracked via tmux's `pane_current_command`:

```
tmux list-panes -t <session>:<window_index> -F '#{pane_current_command}'
```

- If the command is the user's shell (`zsh`, `bash`, `sh`, `fish`) → `idle`
- If the command is anything else (`npm`, `vitest`, `git`, etc.) → `working`

The existing status poller polls this alongside agent hook_activity. The `status` column in `user_terminals` is updated on each cycle.

**User terminal activity does NOT affect derived task status.** It is informational only — displayed as a colored dot on the terminal tab (green pulsing = working, grey = idle), matching the visual pattern used for agent tabs.

## Frontend UI

### Tab Bar Layout

```
[ Agent 1 · | Agent 2 · | + ... ┃ Terminal 1 × | Terminal 2 × | + ]
```

- Agent tabs on the left (unchanged behavior)
- Visual separator (subtle border or gap) between agent and terminal groups
- User terminal tabs on the right, each with an `×` close button
- Terminal `+` button at the far right — creates a new shell terminal (no dialog)
- Clicking any tab (agent or terminal) sets `activeWindow` to that tab's `window_index`

### Component Changes

**`AgentTabs.tsx`** — extend to accept `userTerminals` prop:
- Render agent tabs (existing), then separator, then terminal tabs with close buttons, then terminal `+`
- New props: `userTerminals`, `onAddTerminal`, `onCloseTerminal`

**`TaskDetail.tsx`** — wire up terminal lifecycle:
- `handleAddTerminal()` — calls `api.createTerminal(taskId)`, sets `activeWindow` to new terminal's `window_index`
- `handleCloseTerminal(terminalId)` — calls `api.closeTerminal(taskId, terminalId)`, switches to another tab if closing the active one
- Pass `task.user_terminals` to `AgentTabs`
- Terminal tabs only shown when task is running

**`src/lib/api.ts`** — add two methods:
- `createTerminal(taskId)` → POST
- `closeTerminal(taskId, terminalId)` → DELETE

### No Changes Needed

- **`TerminalView.tsx`** — already renders any `taskId + windowIndex` combination
- **`server/terminal.ts`** — WebSocket/PTY streaming works for any tmux window in the session
- **`server/events.ts`** — existing broadcast mechanism is sufficient

## File Change Summary

| File | Change |
|------|--------|
| `server/db.ts` | Add `user_terminals` table + migration |
| `server/types.ts` | Add `UserTerminal` interface, `UserTerminalStatus` type, extend `Task` |
| `server/task-runner.ts` | Add `createShellTerminal()`, `closeShellTerminal()`; update `closeTask()`/`resumeTask()` cleanup |
| `server/api.ts` | Two new endpoints; include `user_terminals` in all task-returning responses |
| `server/poller.ts` | Add terminal activity polling to `pollStatuses()` — query `pane_current_command` for each user terminal, update `status` column |
| `src/lib/api.ts` | Add `createTerminal()`, `closeTerminal()` |
| `src/components/AgentTabs.tsx` | Render terminal tabs with status dots, separator, close buttons, terminal `+` |
| `src/pages/TaskDetail.tsx` | Wire up terminal create/close handlers |

## Edge Cases

- **User kills tmux session** — same risk as today with agents. The tmux window disappears but the DB row persists until task close/delete cleans it up. The terminal view will show a disconnect message.
- **Closing active terminal tab** — frontend switches to the nearest remaining tab (prefer agent tabs, then other terminals).
- **No terminals exist** — terminal section of tab bar is empty; only the `+` button shows after the separator.
- **Task close/resume** — all user terminal rows deleted on close. On resume, tab bar starts clean with only agent tabs.
