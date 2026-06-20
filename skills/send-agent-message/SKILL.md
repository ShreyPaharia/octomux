---
name: send-agent-message
description: Use when you need to send a message or instruction to a specific agent running inside a task
---

# Send a message to an octomux agent

Send a message or instruction to a specific agent within a running task.

## When to use

- Nudging a stuck agent with additional guidance
- Sending follow-up instructions mid-task
- Redirecting an agent's approach
- Providing context an agent is missing

## Steps

1. **Identify the task:**
   - If the user provides a task ID, use it directly
   - If the user references a task by title or description, look it up. Prefer the MCP tool when available (you're in the orchestrator); otherwise fall back to the CLI:
     - MCP: `mcp__octomux__list_tasks()`
     - CLI fallback:
       `bash
    octomux list-tasks --json
    `
       Find the matching task from the list.

2. **Resolve agent number to agent ID:**
   The `send-message` command/tool requires the agent's nanoid, not its label. Get task details to map "Agent N" to the actual ID. Prefer MCP when available; otherwise fall back to the CLI:
   - MCP: `mcp__octomux__get_task({ task_id: '<task-id>' })`
   - CLI fallback:
     ```bash
     octomux get-task <task-id> --json
     ```

   Parse the `agents` array. Each agent has:
   - `id` — the nanoid (use this as the agent identifier)
   - `label` — display name like "Agent 1", "Agent 2"
   - `status` — `running`, `stopped`, etc.
   - `window_index` — tmux window index

   If the user says "Agent 2", find the agent with `label: "Agent 2"` and use its `id`.

   If the task has only one agent, use that agent's ID without asking.

3. **Check agent status:**
   - If the agent's `status` is `stopped`, do NOT send the message. Inform the user that the agent is stopped and suggest resuming the task first.
   - Only send messages to agents with `status: "running"`.

4. **Send the message:**

   Prefer the MCP tool when available (you're in the orchestrator); otherwise fall back to the CLI.

   **MCP (preferred):**

   ```
   mcp__octomux__send_message({
     task_id: '<task-id>',
     message: '<message>',
   })
   ```

   **CLI fallback:**

   ```bash
   octomux send-message "<message>" --task <task-id> --agent <agent-id>
   ```

   The message is sent via tmux `send-keys` to the agent's terminal window. It appears as typed input in the agent's Claude Code session.

5. **Confirm delivery:**
   Report success to the user. If needed, follow up with `mcp__octomux__get_task({ task_id })` (MCP) or `octomux get-task <task-id>` (CLI) to check agent status after sending.

## Examples

**Direct agent reference (MCP):**

> "Send a message to Agent 2 of task abc123def456"

```
mcp__octomux__get_task({ task_id: 'abc123def456' })
// Find agent with label "Agent 2" -> id = "xyz789abc012"
mcp__octomux__send_message({
  task_id: 'abc123def456',
  message: 'Focus on the API routes first, skip the UI for now',
})
```

**Direct agent reference (CLI fallback):**

```bash
octomux get-task abc123def456 --json
# Find agent with label "Agent 2" -> id = "xyz789abc012"
octomux send-message "Focus on the API routes first, skip the UI for now" --task abc123def456 --agent xyz789abc012
```

**Task by title (MCP):**

> "Nudge the stuck agent on the login bug task"

```
mcp__octomux__list_tasks()
// Find task with title matching "login bug" -> id = "abc123def456"
mcp__octomux__get_task({ task_id: 'abc123def456' })
// Single agent -> id = "xyz789abc012"
mcp__octomux__send_message({
  task_id: 'abc123def456',
  message: 'Try checking the auth middleware — the session token might be expired',
})
```

**Task by title (CLI fallback):**

```bash
octomux list-tasks --json
# Find task with title matching "login bug" -> id = "abc123def456"
octomux get-task abc123def456 --json
# Single agent -> id = "xyz789abc012"
octomux send-message "Try checking the auth middleware — the session token might be expired" --task abc123def456 --agent xyz789abc012
```

## Error handling

- **Agent is stopped:** Don't send. Tell the user: "Agent N is stopped. Resume the task first or add a new agent."
- **Task not found:** List tasks with `mcp__octomux__list_tasks()` (MCP) or `octomux list-tasks` (CLI) and ask the user to confirm which task they mean.
- **Multiple agents, none specified:** Show the agent list with labels and statuses, ask which agent to message.

## Notes

- The octomux server must be running (`octomux start`)
- Messages are injected via tmux send-keys — they appear as user input in the agent's session
- Keep messages concise and actionable for best results
- You can send multiple messages to different agents in sequence
