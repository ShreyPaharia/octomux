# User Terminal with LazyVim on Task Detail Screen

## Problem

Users supervising agents need to review code, check diffs (via lazygit), and make quick
interventions in the task's worktree — without leaving the dashboard.

## Solution

A full-screen toggleable user terminal on the task detail page. When toggled, it replaces
the agent view with a terminal running LazyVim in the task's worktree. The tmux window is
lazily created on first open and persists for the task's lifetime.

## Use Cases

- Browse/edit files with LazyVim while agents work
- Check diffs and commit manually via LazyVim's built-in lazygit
- Run quick git/shell commands (`:q` nvim to get a shell, or use nvim's terminal)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Layout | Full-screen toggle (replaces agent view) | User asked for full screen; avoids split complexity |
| Tmux strategy | New window in task's existing session | Reuses all WebSocket/PTY plumbing; simple |
| Auto-setup | Launch `nvim .` in worktree automatically | Primary use case is LazyVim; `:q` gives shell |
| Creation | Lazy — on first toggle | No overhead for tasks where editor isn't used |
| Persistence | Survives toggles and page reloads | tmux window + nvim session stay alive |
| Toggle mechanism | Header button only (no keyboard shortcut) | Terminal captures most shortcuts; button is reliable |

## Architecture

### Page Modes

TaskDetail has two modes: `agents` (default) and `editor`.

```
TaskDetail page
+-- Header: [Back] [Status] [Title] ... [<> Editor] [Resume] [Start]
+-- Mode: "agents" (default) | "editor"
|
+-- agents mode (existing):
|   +-- AgentTabs
|   +-- TerminalView (agent window)
|
+-- editor mode:
    +-- TerminalView (user window)
```

Both TerminalViews stay mounted in the DOM (shown/hidden via CSS) so neither gets
unmounted or reconnected on toggle. This avoids WebSocket churn.

### ASCII Mockups

**Default (agents mode):**

```
+---------------------------------------------------+
| <- Back    Task Title              [<>] [Resume]  |
+---------------------------------------------------+
| [Agent 1] [Agent 2] [+]                          |
+---------------------------------------------------+
|                                                    |
|           Agent terminal (full area)               |
|                                                    |
|                                                    |
+---------------------------------------------------+
```

**Editor mode:**

```
+---------------------------------------------------+
| <- Back    Task Title        [<> active] [Resume] |
+---------------------------------------------------+
|                                                    |
|         LazyVim in worktree (full area)            |
|                                                    |
|                                                    |
+---------------------------------------------------+
```

## Backend Changes

### Database

Add nullable column to `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN user_window_index INTEGER;
```

Default null means user terminal not yet created.

### New Endpoint

**`POST /api/tasks/:id/user-terminal`**

Creates the user terminal tmux window (idempotent).

Request: empty body.

Response: `{ user_window_index: number }`

Logic:
1. Look up task, validate it has a `tmux_session`
2. If `user_window_index` is already set, return it immediately
3. Create new tmux window: `tmux new-window -t {session} -c {worktreePath}`
4. Get the new window's index: `tmux display-message -t {session} -p '#{window_index}'`
5. Send nvim launch: `tmux send-keys -t {session}:{windowIndex} 'nvim .' Enter`
6. Store `user_window_index` on the task row
7. Return `{ user_window_index }`

### Task Lifecycle Integration

- **`closeTask()`** — No special handling. Killing the tmux session kills all windows
  including the user's.
- **`resumeTask()`** — Reset `user_window_index` to null. The user terminal will be
  lazily recreated on next toggle.
- **`deleteTask()`** — No special handling. Session cleanup covers it.

### WebSocket

No changes needed. The existing `/ws/terminal/{taskId}/{windowIndex}` endpoint works
for the user window — it's just another window index.

## Frontend Changes

### TaskDetail.tsx

**New state:**
- `mode: 'agents' | 'editor'` — which view is shown (default: `agents`)
- `userWindowIndex: number | null` — cached from API response

**Toggle function (`toggleEditor`):**
1. If switching to editor mode and `userWindowIndex` is null:
   - Call `POST /api/tasks/:id/user-terminal`
   - Store returned `user_window_index` in state
2. Set `mode` to the opposite value

**Rendering:**
- Both agent view (AgentTabs + agent TerminalView) and editor TerminalView are in the DOM
- Agent view: `className={mode === 'agents' ? 'flex flex-col flex-1' : 'hidden'}`
- Editor view: `className={mode === 'editor' ? 'flex flex-col flex-1' : 'hidden'}`
- Editor TerminalView only mounts once `userWindowIndex` is set

**Editor button visibility:**
- Only show when `task.tmux_session` exists AND status is `running` or `closed`
- Active visual state when `mode === 'editor'`

**Auto-switch back to agents:**
- When task status changes to `setting_up`, `closed`, or `error`, auto-set mode to `agents`
- This handles: task close while in editor, task resume (goes through setting_up)

### TerminalView.tsx

**New behavior: fit-on-show.**

The hidden terminal won't resize with the browser window. When it becomes visible again,
it needs to refit.

Options:
- Accept a `visible` prop; run `fitAddon.fit()` in a useEffect when it changes to true
- Or use a ResizeObserver (already exists) — if the container goes from 0 dimensions to
  non-zero, that triggers a fit automatically

The existing ResizeObserver approach should handle this naturally since the container
goes from `display:none` (0x0) to visible (actual dimensions). Verify this works; if
not, add the `visible` prop approach.

### Header Button

Add a toggle button in the TaskDetail header:
- Icon: code bracket icon (`<>`) or terminal icon
- Label: "Editor" (or just the icon for compactness)
- Active state: highlighted/filled when in editor mode
- Position: grouped with other action buttons

## Edge Cases

| Scenario | Handling |
|----------|----------|
| User quits nvim (`:q`) | Lands in shell at worktree path — expected and useful |
| Task closed while in editor mode | Auto-switch to agents mode |
| Task resumed | `user_window_index` reset to null; mode switches to agents |
| Page reload while in editor mode | Defaults to agents mode; button click reconnects instantly (window still alive) |
| tmux session dies unexpectedly | TerminalView shows existing reconnect/error UI |
| Multiple browser tabs | Each gets its own PTY attached to same tmux window (existing behavior) |
| Task in draft/setting_up/error | Editor button hidden — no tmux session available |
| API call to create user terminal fails | Show error toast; stay in agents mode |

## Future Enhancement (Separate Task)

- Agent status bar visible in editor mode — thin bar showing agent status pills so user
  has awareness of agent activity while editing

## Testing Strategy

### Backend
- Unit test for new endpoint: creates window, returns index, idempotent on second call
- Unit test: resumeTask resets user_window_index to null
- Test: endpoint returns 400/404 for invalid task or task without tmux session

### Frontend
- Component test: editor button hidden when no tmux session
- Component test: toggle switches between modes
- Component test: auto-switch to agents on task status change
- E2E: create task, open editor, verify terminal connects, toggle back

## Files to Modify

### Backend
- `server/db.ts` — add `user_window_index` column to schema
- `server/types.ts` — add `user_window_index` to Task type
- `server/api.ts` — add POST `/api/tasks/:id/user-terminal` endpoint
- `server/task-runner.ts` — add `createUserTerminal()` function; reset index in `resumeTask()`

### Frontend
- `src/pages/TaskDetail.tsx` — add mode state, toggle logic, dual terminal rendering
- `src/components/TerminalView.tsx` — verify fit-on-show works (may need visible prop)
- `src/lib/api.ts` — add `createUserTerminal(taskId)` API function
