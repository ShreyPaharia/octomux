---
name: create-task
description: Use when creating an octomux task to dispatch autonomous Claude Code agents for building features, fixing bugs, or any code changes
---

# Create an octomux task

Dispatch an autonomous Claude Code agent to work on a feature, bugfix, or code change via octomux.

## Steps

1. **Understand the goal:**
   - Ask the user what they want built/fixed, or infer from context (e.g. a Linear/Jira ticket URL, a bug description, a feature request)
   - If given a ticket URL or key (e.g. `BAC-843`, `PROJ-843`), fetch the ticket details. Ticket keys match `[A-Z][A-Z0-9]+-\d+`. Decide tracker (Linear vs Jira) using the rules below.

   **How to decide which tracker the key belongs to:**

   - Full URL with `linear.app/` → Linear.
   - Full URL with `*.atlassian.net/` → Jira.
   - Bare key (e.g. `BAC-123`):
     - Call `mcp__plugin_linear_linear__list_teams()` and check whether the key prefix matches a Linear team's key → Linear.
     - Otherwise treat as Jira.
   - If ambiguous (both could match), prefer `defaultTracker` from `~/.octomux/settings.json`.

   **Fetching Linear issue details:**
   1. Extract the issue key (e.g. `BAC-843`).
   2. Use Linear MCP tools:
      - `mcp__plugin_linear_linear__get_issue({ query: '<issue-key>' })` to fetch title, description, state, labels, priority, team, project.
   3. Map fields to the prompt template:
      - `title` → task title + What section
      - `description` → Context section (extract acceptance criteria if present)
      - `labels[].name` / `priority` → urgency hints in Why section
      - `team.key` + `team.id` + `project.id` + `id` (issue UUID) → ref metadata (Step 6a below)
      - `state` → ignored (octomux owns workflow state)
   4. Branch naming uses the same convention: `feat/BAC-123-add-position-sync`.

   **Fetching Jira ticket details:**
   1. Extract the ticket key from the URL (e.g., `PROJ-843` from `https://your-company.atlassian.net/browse/PROJ-843`)
   2. Use Atlassian MCP tools:
      - `getAccessibleAtlassianResources()` to get `cloudId`
      - `getJiraIssue(cloudId, issueKey, fields=["summary","description","priority","labels","status"])` to get ticket details
   3. Map fields to the prompt template:
      - `summary` -> title + What section
      - `description` -> Context section (extract acceptance criteria if embedded)
      - `priority` / `labels` -> inform urgency in Why section
   4. If the description contains acceptance criteria (bullet lists, checkboxes), extract them verbatim for the Acceptance Criteria section

   If `~/.octomux/settings.json` has `defaultJiraBaseUrl` / `defaultJiraProjectKey` / `defaultLinearTeamKey`, treat those as the user's defaults when inferring a URL or assuming a project/team key.

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

   **From a Jira ticket** (e.g. `PROJ-123` — substitute your project key):

   ```
   feat/PROJ-123-add-position-sync
   fix/PROJ-456-decimal-exponent-bloat
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

   **Always append this to the end of the prompt:**

   ```
   When finished, output a structured summary:
   ## Done
   - **Changes:** <file count> files changed
   - **Tests:** <pass/fail summary>
   - **Commits:** <commit messages>
   ```

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

6a. **Link the source ticket (if applicable):**

   If the source was a Linear issue, immediately link it with the cached metadata so the status-sync handler doesn't need to refetch the team on every column change:

   ```bash
   octomux task-ref-add <task-id> linear BAC-843 \
     --url 'https://linear.app/ostium-labs/issue/BAC-843' \
     --metadata '{"team_key":"BAC","team_id":"<uuid>","issue_id":"<uuid>","project_id":null}'
   ```

   `team_id`, `issue_id`, and `project_id` come from the `get_issue` response. The handler falls back to a runtime lookup if metadata is missing, but caching is faster and rate-limit-friendly.

   If the source was a Jira issue, link it without metadata:

   ```bash
   octomux task-ref-add <task-id> jira PROJ-843 \
     --url 'https://your-company.atlassian.net/browse/PROJ-843'
   ```

7. **Report:**
   - Print the task ID returned by the CLI
   - Tell the user to monitor via `octomux list-tasks` or the dashboard
   - Or via CLI: `octomux list-tasks`

## Forking an existing task

Use `--fork-from <task-id>` to start a new task from the branch of an existing task. The new task gets its own worktree and its own branch; the source task is left untouched.

```bash
octomux create-task \
  --fork-from ABC123XYZ \
  --title 'Try a different approach' \
  --description 'Explore alternative implementation on top of ABC123XYZ' \
  --branch 'feat/try-alt-approach' \
  --initial-prompt 'Continue from the current state. Consider a simpler approach to ...'
```

**What it does:**

- Sets `--base-branch` to `agents/<task-id>` — you MUST NOT pass `--base-branch` yourself (the two flags are mutually exclusive and the CLI will error).
- Inherits `--repo-path` from the source task if you don't pass one.
- All other flags (`--title`, `--description`, `--branch`, `--initial-prompt`, etc.) behave exactly as usual.

**Dirty source warning:**

If the source task's worktree has uncommitted changes, the CLI prints a warning to stderr like:

```
Warning: Source task ABC123XYZ has uncommitted changes; fork starts from last commit 1a2b3c4. Those changes will not be in the fork.
```

The fork proceeds anyway — but expect to re-apply any uncommitted work manually if you need it in the fork. If you want those changes in the fork, commit them in the source first.

**Refusal cases (the CLI exits non-zero):**

- Source task does not exist.
- Source's `status` is `draft` (task was never started, so there's no branch yet).
- Source's `run_mode` is `scratch` or `none` (task runs in the repo directory with no branch to fork from).
- Both `--fork-from` and `--base-branch` are passed (mutually exclusive).

## Notes

- The octomux server must be running (start with `octomux start`)
- Tasks start immediately by default — agents begin working right away
- Each task gets its own git worktree and tmux session for isolation
- Keep titles short (under 60 chars) and descriptive
- Initial prompts should be specific and actionable
- Monitor tasks via `octomux list-tasks` or the dashboard
- To create PRs for completed tasks, use the `create-pr` skill
