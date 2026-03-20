# Orchestrator Command Bar

**Date:** 2026-03-19
**Status:** Draft

## Problem

The orchestrator is powerful but hidden. Users must: click the Orchestrator button in the header → open the modal → start the orchestrator → then type. Common actions like creating a task require either knowing what to type or using a separate form dialog. There's no discoverability of what the orchestrator can do from the dashboard itself.

## Solution

A persistent command bar on the dashboard that serves as the primary entry point to the orchestrator. It provides a text input for natural language messages and quick action chips that pre-fill prompt templates. Submitting sends the message to the orchestrator's tmux session and auto-opens the modal for the user to see the response.

## Design

### Layout

The command bar sits at the top of the dashboard content area, between the header and the task filter bar:

```
AppHeader (persistent)
─────────────────────────────────────────────
OrchestratorCommandBar                    ← NEW
TaskFilterBar
TaskList
```

### Command Bar Structure

```
┌──────────────────────────────────────────────────────────────┐
│  ⌨  Ask the orchestrator anything...               [Send ▶] │
├──────────────────────────────────────────────────────────────┤
│  [+ Create Task]  [List Tasks]  [Task Status]  [Create PR]  │
└──────────────────────────────────────────────────────────────┘
```

- Single-line text input that expands to max 3 lines as content grows
- Send button (also triggered by Enter; Shift+Enter for newlines)
- Quick action chips below the input
- Subtle card styling (border, rounded corners, bg-card)

### Quick Action Chips

Each chip pre-fills the input with a natural language prompt template. Bracketed portions are placeholders the user replaces:

| Chip Label | Pre-filled Template |
|---|---|
| **+ Create Task** | `Create a task titled "[title]" in repo [/path/to/repo] with prompt: [describe what the agent should do]` |
| **List Tasks** | `Show me all running tasks` |
| **Task Status** | `What is the status of task [id]?` |
| **Create PR** | `Create a PR for task [id]` |

When a chip is clicked:
- The template replaces the current input content
- The first `[placeholder]` is selected/highlighted so the user can type over it immediately
- For templates with no placeholders (e.g., "List Tasks"), the message is sent immediately

### Slash Command Autocomplete

Typing `/` at the start of the input triggers a dropdown menu with available commands. The commands share the same data source as the quick action chips — one list, two entry points (chips for mouse, slash commands for keyboard).

**Dropdown appearance:**

```
┌──────────────────────────────────────────────────────────────┐
│  /cr                                                         │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────┐             │
│  │ ▸ /create-task                              │             │
│  │   Create a task for an autonomous agent     │             │
│  │                                             │             │
│  │   /create-pr                                │             │
│  │   Create a PR for a completed task          │             │
│  └─────────────────────────────────────────────┘             │
├──────────────────────────────────────────────────────────────┤
│  [+ Create Task]  [List Tasks]  [Task Status]  [Create PR]  │
└──────────────────────────────────────────────────────────────┘
```

**Commands:**

| Command | Description | Template |
|---|---|---|
| `/create-task` | Create a task for an autonomous agent | Same as Create Task chip |
| `/list-tasks` | Show all running tasks | Same as List Tasks chip |
| `/status` | Check status of a specific task | Same as Task Status chip |
| `/create-pr` | Create a PR for a completed task | Same as Create PR chip |

**Shared data source:**

```ts
const COMMANDS = [
  {
    slash: '/create-task',
    chipLabel: '+ Create Task',
    description: 'Create a task for an autonomous agent',
    template: 'Create a task titled "[title]" in repo [/path/to/repo] with prompt: [describe what the agent should do]',
    hasPlaceholders: true,
  },
  // ... etc
];
```

**Behavior:**
- Dropdown appears when input starts with `/` and the input is otherwise at the beginning (not mid-sentence)
- Typing after `/` filters the list (e.g., `/cr` shows `/create-task` and `/create-pr`)
- Arrow keys navigate the dropdown, Enter selects the highlighted command
- Selecting a command replaces the input with the command's template (same behavior as clicking a chip)
- Escape closes the dropdown without selecting
- Clicking outside the dropdown closes it
- Dropdown is positioned above the chips, anchored to the left edge of the input

### Interaction Flow

1. **User types or clicks a chip** → input is populated with text
2. **User presses Enter or clicks Send** →
   - If orchestrator is **not running**: auto-start it, then send the message once ready
   - If orchestrator is **running**: send the message to the tmux session
   - **Auto-open the orchestrator modal** so user sees the response streaming in the terminal
3. **If orchestrator is busy** (mid-conversation, processing a tool call):
   - The modal opens, showing the current terminal state
   - The message is held in the input bar — user sees what's happening and can choose to send now (message queues in terminal buffer) or wait

### Auto-Start Behavior

Currently starting the orchestrator requires: open modal → click "Start Orchestrator". The command bar removes this friction:

- Submitting a message auto-starts the orchestrator if not running
- A brief loading state shows on the send button ("Starting...") during boot
- The initial greeting message is still sent, followed by the user's message

### New Backend Endpoint

```
POST /api/orchestrator/send
Content-Type: application/json
Body: { "message": "Create a task titled..." }

Success: { "ok": true, "running": true }
Error:   { "ok": false, "error": "Failed to start orchestrator" } (HTTP 500)
```

Implementation:
- Calls `startOrchestrator()` if not already running
- **Auto-start + message delivery**: Modify `startOrchestrator()` to accept an optional `initialMessage` parameter. When provided, the Claude launch command becomes:
  `claude --system-prompt "$(cat ...)" "Greet me, then handle: <message>"`.
  This eliminates the race condition of sending a message before Claude is ready — the message is baked into the initial prompt.
- If orchestrator is already running, send the message via `tmux send-keys -l -t octomux-orchestrator "<message>" Enter`. The `-l` flag (literal mode) prevents tmux from interpreting key names (e.g., `C-c`, `Enter` in the message text). Since `execFile` is used (not `exec`), shell metacharacters are not interpreted — no additional shell escaping is needed.
- Returns `{ "ok": true, "running": true }` so the frontend can update orchestrator state immediately without waiting for the next poll cycle.

### Component: `OrchestratorCommandBar`

**Location:** `src/components/OrchestratorCommandBar.tsx`

**Props:** None (uses `useOrchestratorContext()` for state)

**State:**
- `input: string` — current input text
- `sending: boolean` — true while the send request is in flight (covers both auto-start and send-to-running cases)
- `showSlashMenu: boolean` — true when input starts with `/` and dropdown should be visible
- `slashFilter: string` — the text after `/` used to filter commands
- `selectedIndex: number` — currently highlighted item in the slash dropdown

**Dependencies:**
- `useOrchestratorContext()` — for `running`, `open()`, `start()`
- `api.sendOrchestratorMessage(message)` — new API client method

### Integration in Dashboard

```tsx
// Dashboard.tsx
<div className="mx-auto max-w-6xl px-4 py-4">
  <OrchestratorCommandBar />    {/* NEW */}
  <TaskFilterBar ... />
  <TaskList ... />
</div>
```

### Edge Cases

- **Empty input**: Send button is disabled, Enter does nothing
- **Long messages**: Input grows to max 3 lines, then scrolls internally. Use a `<textarea>` with `rows={1}` and JS-driven height adjustment.
- **Escape key in input**: Clears the input. Uses `stopPropagation()` so it does not close the modal if it happens to be open.
- **Chip click with existing text**: Replaces input content (no confirmation for v1). Focus moves to the input and selects the first placeholder.
- **Chip with no placeholders** (e.g., "List Tasks"): Sends immediately. The input briefly flashes the template text before clearing, so the user sees what was sent.
- **Orchestrator fails to start**: Show error toast, re-enable send button, keep input text so user can retry.
- **After successful send**: Input is cleared.
- **Shell injection**: Handled by `tmux send-keys -l` (literal mode) + `execFile` (no shell). See backend endpoint section.
- **Slash menu with no matches**: If the filter matches nothing (e.g., `/xyz`), hide the dropdown. The text remains as regular input — submitting `/xyz do something` sends it as a natural language message to the orchestrator.
- **Slash command Escape**: Closes the dropdown, keeps the text in the input. A second Escape clears the input.

## What We're NOT Building (v1)

- Chat UI or markdown rendering (terminal handles display)
- Busy/idle detection for the orchestrator
- Changes to the orchestrator modal
- Changes to the orchestrator system prompt
- Removing the existing CreateTaskDialog (it remains as an alternative)

## Future Considerations

- Recent command history in the input
- Smart suggestions based on current task state (e.g., "3 tasks running — check status?")
- Busy detection to warn before sending to a busy orchestrator
- Keyboard shortcut (Cmd+K or `/`) to focus the command bar
