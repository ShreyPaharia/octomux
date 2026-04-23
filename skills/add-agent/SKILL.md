---
name: add-agent
description: Use when you need to attach a new Claude Code agent (new tmux window) to an existing running octomux task, sharing the task's worktree and cwd
---

# Add an agent to an octomux task

Attach a new Claude Code agent to an existing running task via `octomux add-agent`. The new agent is a fresh tmux window inside the task's tmux session, sharing the task's worktree/cwd. Each task can hold multiple agents working in parallel in the same worktree.

## Distinction from `send-agent-message`

- **`add-agent`** — creates a NEW agent (new tmux window, new Claude Code process) attached to an existing task. Use this to spin up an additional helper agent (e.g. a reviewer) alongside the original agent.
- **`send-agent-message`** — sends a message to an ALREADY-RUNNING agent via tmux `send-keys`. Use this to nudge or redirect an agent that is already working.

If you want another voice in the task, use `add-agent`. If you want to talk to the voice already there, use `send-agent-message`.

## When to use

- Adding a reviewer / QA agent alongside an implementing agent
- Spawning an additional helper to work on a subtask in the same worktree
- Continuing an interrupted task with a fresh prompt without losing the original context in the running agent

## Steps

1. **Identify the task:**
   - If the user provides a task ID, use it directly
   - Otherwise look it up via `octomux list-tasks --json` and find the task by title/description
   - The task must be in `running` status — `add-agent` will fail otherwise

2. **Craft a focused initial prompt** for the new agent. Keep it specific: the new agent lands in the same worktree but knows nothing about what the first agent has been doing.

3. **Run the command:**

   ```bash
   octomux add-agent \
     --task <task-id> \
     --prompt '<initial prompt for the new agent>'
   ```

   Optional flags:
   - `--agent <agent-type>` — use a Claude Code agent type (e.g. `code-reviewer`). Default: plain `claude` with no specific agent type.
   - `--label <label>` — custom label for the new agent. Default: server-assigned `"Agent N"`.

4. **Report:** the command prints the new agent's ID, label, and tmux window index on success. Pass the agent ID back to the user so they can `send-agent-message` to it later.

## Examples

**Add a reviewer to a running implementation task:**

```bash
octomux add-agent \
  --task ABC123XYZ \
  --agent code-reviewer \
  --label 'Reviewer' \
  --prompt 'Review the diff on this branch against main. Focus on correctness and edge cases, flag anything risky.'
```

**Add a second implementer to parallelize a subtask:**

```bash
octomux add-agent \
  --task ABC123XYZ \
  --prompt 'While Agent 1 finishes the API work, scaffold the frontend table in src/pages/tasks/. Do not touch server/ files.'
```

## Notes

- The octomux server must be running (`octomux start`)
- The task must be in `running` status; `add-agent` fails on `draft`, `setting_up`, `closed`, or `error` tasks
- The new agent shares the task's worktree — both agents operate on the same files, so coordinate explicitly via prompts to avoid conflicts
- Monitor the new agent via `octomux get-task <task-id>` or the dashboard
