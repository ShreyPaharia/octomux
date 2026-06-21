---
name: update-task-status
description: Use when you want to update the workflow status of an octomux task, add a note, post a progress summary, or link external references (e.g. Jira tickets)
---

# Update octomux task status

Move a task through the workflow board, add notes, post progress summaries, or link external references.

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

- Moving to `human_review` or `planned` requires a note explaining why — use `--note` with the CLI, or follow up with `octomux task-note` (or a note in your message) when using the MCP tool
- The move is recorded in the task activity log automatically

## Posting a progress summary

A summary is a short, human-readable status snapshot stored on the task. Agents should post summaries when they reach key milestones.

```bash
octomux task-summary <task-id> "<summary text>"
```

**Example:**

```bash
octomux task-summary abc123 "Completed auth middleware refactor. Tests pass. Writing migration docs next."
```

The summary appears in the dashboard task card and is visible to humans monitoring work.

## Adding a note to the activity log

Notes are append-only timeline entries — useful for capturing decisions, blockers, or context without overwriting the summary.

```bash
octomux task-note <task-id> "<note text>"
```

**Example:**

```bash
octomux task-note abc123 "Decided to defer DB migration to a follow-up task (see PROJ-999)"
```

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

- **Agent completing a milestone:** post a summary via `octomux task-summary`
- **Agent blocked on human input:** move to `human_review` with a note explaining what's needed — use `mcp__octomux__set_task_status` (MCP) or `octomux task-move` (CLI)
- **Human reviewing work:** add notes, move to `done` after merge
- **Linking a Jira ticket to a new task:** use `task-ref-add` immediately after creating the task
- **Tracking decisions or context:** use `task-note` to capture anything that affects how the work is understood later

## Tips

- Keep summaries under 2-3 sentences — they appear in dashboard cards
- Use notes for longer context or multi-line decisions
- Always include a note when moving to `human_review` so the reviewer knows what to look at
- The `--author` flag on `task-summary` and `task-note` defaults to `cli` but can be set to the agent ID or your name for attribution
