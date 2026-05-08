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

```bash
octomux task-move <task-id> <workflow_status>
```

**Examples:**

```bash
# Move to human review with a note
octomux task-move abc123 human_review --note "PR draft ready, need design sign-off"

# Mark as planned
octomux task-move abc123 planned --note "Scoped in sprint planning"

# Mark as done after merge
octomux task-move abc123 done
```

**Notes:**

- Moving to `human_review` or `planned` requires `--note` explaining why
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
octomux task-note abc123 "Decided to defer DB migration to a follow-up task (see IN-999)"
```

## Linking external references

Link a Jira ticket, GitHub issue, or any external item to a task:

```bash
octomux task-ref-add <task-id> <integration> <external-id> [--url <url>] [--title <title>]
```

**Examples:**

```bash
# Link a Jira ticket
octomux task-ref-add abc123 jira IN-843 \
  --url "https://ostium.atlassian.net/browse/IN-843" \
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

## When to use this skill

- **Agent completing a milestone:** post a summary via `task-summary`
- **Agent blocked on human input:** move to `human_review` with a note explaining what's needed
- **Human reviewing work:** add notes, move to `done` after merge
- **Linking a Jira ticket to a new task:** use `task-ref-add` immediately after creating the task
- **Tracking decisions or context:** use `task-note` to capture anything that affects how the work is understood later

## Tips

- Keep summaries under 2-3 sentences — they appear in dashboard cards
- Use notes for longer context or multi-line decisions
- Always include `--note` when moving to `human_review` so the reviewer knows what to look at
- The `--author` flag on `task-summary` and `task-note` defaults to `cli` but can be set to the agent ID or your name for attribution
