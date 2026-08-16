---
name: update-task-status
description: Use when you want to update the workflow status of an octomux task, add a note, rename it, or link external references (e.g. Jira tickets)
---

# Update octomux task status

Move a task through the workflow board, add notes, rename the task, or link external references.

## Workflow columns

Tasks flow through these columns in order (though any transition is allowed):

| Column         | When to use                        |
| -------------- | ---------------------------------- |
| `backlog`      | Idea captured, not yet planned     |
| `planned`      | Scoped and ready to start          |
| `in_progress`  | Active work underway               |
| `human_review` | Blocked on human review / feedback |
| `pr`           | PR open, awaiting merge            |
| `done`         | Merged / shipped                   |

## Moving a task to a different column

Prefer the MCP tool when available (you're in the orchestrator); otherwise fall back to the CLI.

**MCP (preferred):**

```
mcp__octomux__set_task_status({
  task_id: '<task-id>',
  status: '<workflow_status>',
})
```

**CLI fallback:**

```bash
octomux task-move <task-id> <workflow_status>
```

**Examples:**

```
// Move to human review (MCP)
mcp__octomux__set_task_status({ task_id: 'abc123', status: 'human_review' })

// Mark as planned (MCP)
mcp__octomux__set_task_status({ task_id: 'abc123', status: 'planned' })

// Mark as done after merge (MCP)
mcp__octomux__set_task_status({ task_id: 'abc123', status: 'done' })
```

```bash
# Move to human review with a note (CLI fallback)
octomux task-move abc123 human_review --note "PR draft ready, need design sign-off"

# Mark as planned (CLI fallback)
octomux task-move abc123 planned --note "Scoped in sprint planning"

# Mark as done after merge (CLI fallback)
octomux task-move abc123 done
```

**Notes:**

- Moving to `human_review` or `planned` requires a note explaining why — use `--note` with the CLI, or mention it in your message when using the MCP tool
- The move is recorded in the task activity log automatically

## Renaming a task

A task's title defaults to the first 80 characters of its initial prompt, which is usually unreadable on the board. Rename it once you understand what the task is actually about.

```bash
# From inside the task — id comes from the OCTOMUX_TASK_ID env var
octomux task rename --title "New title"

# From outside a task — pass the task id explicitly
octomux task rename --id <task-id> --title "New title"

# Optionally update the description too
octomux task rename --title "New title" --description "One-line summary"
```

**Example:**

```bash
octomux task rename --title "Fix auth middleware token refresh bug"
```

**When to use it:** right after you understand what the task actually is — do this once, early, so the board shows a readable title instead of a truncated prompt.

## Linking external references

Link a Linear issue, Jira ticket, GitHub issue, or any external item to a task:

```bash
octomux task-ref-add <task-id> <integration> <external-id> [--url <url>] [--title <title>] [--metadata <json>]
```

The `--metadata` flag accepts a JSON object with integration-specific fields. For Linear, cache `team_key`/`team_id`/`issue_id`/`project_id` so the status-sync handler doesn't need extra API calls on every column change.

**Examples:**

```bash
# Link a Linear issue (Backend team example)
octomux task-ref-add abc123 linear BAC-843 \
  --url "https://linear.app/ostium-labs/issue/BAC-843" \
  --title "Add position sync to backend" \
  --metadata '{"team_key":"BAC","team_id":"a3b9a29e-9847-4f5e-9eae-6dc0eb63da92","issue_id":"<issue-uuid>"}'

# Link a Jira ticket (substitute your project key + Jira host)
octomux task-ref-add abc123 jira PROJ-843 \
  --url "https://your-company.atlassian.net/browse/PROJ-843" \
  --title "Add position sync to backend"

# Link a GitHub issue
octomux task-ref-add abc123 github 42 \
  --url "https://github.com/org/repo/issues/42" \
  --title "Terminal resize bug"
```

Remove a reference:

```bash
octomux task-ref-rm <task-id> <integration>
```

## Viewing the activity log

```bash
octomux task-updates <task-id>
```

## Finding a task by title

If you need to look up a task ID by name, prefer the MCP tool when available (you're in the orchestrator); otherwise fall back to the CLI:

- MCP: `mcp__octomux__list_tasks()`
- CLI fallback: `octomux list-tasks --json`

## When to use this skill

- **Agent understands what the task is about:** rename it via `octomux task rename` so the board shows a readable title
- **Agent blocked on human input:** move to `human_review` with a note explaining what's needed — use `mcp__octomux__set_task_status` (MCP) or `octomux task-move` (CLI)
- **Human reviewing work:** add notes, move to `done` after merge
- **Linking a Jira ticket to a new task:** use `task-ref-add` immediately after creating the task

## Tips

- Always include a note when moving to `human_review` so the reviewer knows what to look at
- Rename the task once, early — don't rename repeatedly as understanding evolves
