---
name: octomux-create-task
description: Use when creating an octomux task to dispatch autonomous Claude Code agents for building features, fixing bugs, or any code changes
---

# Create an octomux task

Dispatch an autonomous Claude Code agent to work on a feature, bugfix, or code change via octomux.

## Steps

1. **Understand the goal:**
   - Ask the user what they want built/fixed, or infer from context (e.g. a Jira ticket URL, a bug description, a feature request)
   - If given a Jira ticket URL, fetch the ticket details to extract title, description, and acceptance criteria

2. **Resolve the repo:**
   - Query recent repos via CLI:
     ```bash
     octomux recent-repos
     ```
   - If the repo is ambiguous, ask the user

3. **Detect base branch:**

   ```bash
   octomux default-branch --repo-path <resolved_path>
   ```

4. **Generate the branch name:**
   Follow GitHub/conventional branch naming best practices. The branch name doubles as the worktree directory name.

   **Format:** `<type>/<scope>` where:
   - `<type>` = `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf` (match the nature of the work)
   - `<scope>` = kebab-case short description (max ~40 chars, no task ID suffix)

   **From a Jira ticket** (e.g. IN-123):

   ```
   feat/IN-123-add-position-sync
   fix/IN-456-decimal-exponent-bloat
   ```

   **From a GitHub issue** (e.g. #42):

   ```
   feat/42-websocket-real-time-updates
   fix/42-terminal-resize-bug
   ```

   **Without a ticket/issue:**

   ```
   fix/tmux-session-leak
   feat/cli-arg-parsing
   chore/cleanup-packaging
   refactor/split-task-runner
   perf/optimize-ui-rendering
   ```

   Pass it via `--branch`:

   ```bash
   --branch 'fix/tmux-session-leak'
   ```

5. **Craft the initial prompt:**
   Build a well-structured prompt that includes:
   - Clear description of the goal
   - Acceptance criteria (if available from a ticket)
   - Standard instructions: `Run tests before finishing. Follow conventional commits. Keep changes minimal and focused.`

   The prompt should be specific and actionable — vague prompts lead to agents going in circles.

6. **Create the task:**

   ```bash
   octomux create-task \
     --title '<title>' \
     --description '<description>' \
     --repo-path '<resolved_path>' \
     --branch '<branch_name>' \
     --base-branch '<detected_branch>' \
     --initial-prompt '<crafted_prompt>'
   ```

7. **Report:**
   - Print the task ID returned by the CLI
   - Tell the user to monitor via `octomux list-tasks` or the dashboard
   - Or via CLI: `octomux list-tasks`

## Notes

- The octomux server must be running (start with `octomux start`)
- Tasks start immediately by default — agents begin working right away
- Each task gets its own git worktree and tmux session for isolation
- Keep titles short (under 60 chars) and descriptive
- Initial prompts should be specific and actionable
- Monitor tasks via `octomux list-tasks` or the dashboard
- To create PRs for completed tasks, use the `octomux-create-pr` skill
