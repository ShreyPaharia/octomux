---
name: review-learnings
description: Extract reusable learnings from completed octomux agent sessions and append to .claude/rules/learnings.md. Use when reviewing what agents learned, or to manually add a learning.
---

# Review Learnings

Extract reusable learnings from closed octomux-agents tasks and add them to the repo's
`.claude/rules/learnings.md` so future agents (and human sessions) benefit automatically.

## Usage

- `/review-learnings` — review all unreviewed closed tasks
- `/review-learnings <task-id>` — review a specific task
- `/review-learnings add "..."` — manually add a learning to current repo

## Manual Add Mode

If the argument starts with `add`, extract the quoted text and append it as a bullet to
`.claude/rules/learnings.md` in the target repo:

1. Determine target repo:
   - If `--repo <path>` is provided, use that path
   - Otherwise, run `git rev-parse --show-toplevel` to get the current repo root
2. Read `<repo>/.claude/rules/learnings.md` (if it exists)
3. If the file doesn't exist, create it:

   ```bash
   mkdir -p <repo>/.claude/rules
   ```

   Then write the file with:

   ```
   # Learnings

   - <the learning text>
   ```

4. If the file exists, append `- <the learning text>` on a new line at the end
5. Confirm: `Added learning to <repo>/.claude/rules/learnings.md`

**Then stop.** Manual add does not run extraction or review.

## Extraction Mode

### Step 1: Fetch closed, unreviewed tasks

```bash
curl -s http://localhost:7777/api/tasks | jq .
```

Parse the JSON response. Filter to tasks where:

- `status === "closed"`
- If a specific `<task-id>` argument was provided, also filter to that task

For each closed task, check if it has already been reviewed:

- If `task.worktree` is null or the worktree directory doesn't exist on disk, **skip** this
  task silently (worktree was deleted, nothing to review)
- The task's `worktree` field gives the worktree path (e.g., `/Users/alice/repos/myapp/.worktrees/abc123`)
- Check if `<worktree>/.learnings-reviewed` exists:
  ```bash
  stat <worktree>/.learnings-reviewed
  ```
- If the marker file exists, compare its mtime against the task's `updated_at`:
  - If `updated_at` is AFTER the marker's mtime → treat as **unreviewed** (task was resumed)
  - If `updated_at` is BEFORE or equal → **already reviewed**, skip
- If the marker file doesn't exist → **unreviewed**

If no unreviewed tasks remain, report: "No unreviewed closed tasks found." and stop.

### Step 2: For each unreviewed task, locate and parse JSONL session files

Each task has one or more agents. For each agent in `task.agents`:

1. **Skip** if `agent.claude_session_id` is null (agent never started a Claude session)

2. **Resolve the JSONL path:**

   ```
   ~/.claude/projects/<project-key>/<session-id>.jsonl
   ```

   Where:
   - `project-key` = the agent's worktree absolute path with both `/` and `.` replaced by `-`
     - Example: `/Users/alice/repos/myapp/.worktrees/abc123`
     - Becomes: `-Users-alice-repos-myapp--worktrees-abc123`
     - (The leading `/` becomes a leading `-`. The `.` in `.worktrees` also becomes `-`, creating `--worktrees`.)
   - `session-id` = `agent.claude_session_id` (UUID)

   The worktree path comes from `task.worktree`.

3. **Check if the JSONL file exists:**

   ```bash
   stat ~/.claude/projects/<project-key>/<session-id>.jsonl
   ```

   If missing, warn: `"JSONL not found for agent <label> — skipping"` and continue.

4. **Read and parse the JSONL file:**

   ```bash
   cat ~/.claude/projects/<project-key>/<session-id>.jsonl
   ```

   Each line is a JSON object. Extract conversation content:
   - **Keep** lines where `type === "user"` — extract `message.content`
   - **Keep** lines where `type === "assistant"` — from `message.content` array, keep only
     blocks with `type === "text"` (skip `thinking`, `tool_use` blocks)
   - **Keep** lines where `type === "result"` — these contain tool execution results.
     Only keep results where `is_error === true` (error outputs are high-signal for learnings).
     Skip successful tool results (they are verbose and low-signal).
   - **Note** lines where `type === "system"` and `subtype === "compact_boundary"` — these
     mark context compaction points. Use them to split the session into segments (see below).
   - **Skip** lines where `type` is `progress`, `file-history-snapshot`, `queue-operation`,
     `last-prompt`, or any other type not listed above

   **Segmentation:** Always identify `compact_boundary` markers to split the session into
   logical segments. For normal-length sessions, process all segments together as one
   transcript. For very long sessions where the extracted transcript exceeds ~3MB of text
   (roughly 800k tokens), process each segment separately and deduplicate candidates across
   segments by comparing summary text.

   Build the conversation as a readable transcript:

   ```
   USER: <content>
   ASSISTANT: <text content>
   ERROR: <error tool result>
   --- segment boundary ---
   USER: <content>
   ...
   ```

### Step 3: Read existing learnings and CLAUDE.md

For each task, read the existing learnings from the task's `repo_path`:

```bash
cat <repo_path>/.claude/rules/learnings.md 2>/dev/null || echo ""
cat <repo_path>/CLAUDE.md 2>/dev/null || echo ""
```

### Step 4: Extract learnings via model

For each task, present the parsed session transcript to the model with this prompt:

```
Extract reusable learnings from this agent session transcript.

Focus on:
- Error resolutions (what broke and how it was fixed)
- Codebase patterns (conventions, file organization, naming)
- Build/test commands that work
- Environment requirements (env vars, services, dependencies)
- Gotchas and workarounds
- Non-obvious configuration or setup steps

Here are the EXISTING learnings and CLAUDE.md — DO NOT duplicate anything already covered:

<existing .claude/rules/learnings.md content>

<existing CLAUDE.md content>

Return a JSON array of learnings:
[{"summary": "one-line learning, concise and actionable"}]

Rules:
- Only include learnings useful to a FUTURE agent working on this repo
- Each learning should be a single actionable bullet point
- Be specific: include exact commands, file paths, env var names
- Return empty array [] if nothing reusable was found
- Do NOT include learnings about the task's specific feature/bug — only reusable patterns

SESSION TRANSCRIPT:
<transcript>
```

Collect the returned JSON array of candidates for this task.

If the model returns an empty array: report "No new learnings found for '<task title>'" and
mark this task as reviewed (Step 6).

### Step 5: Present candidates for approval

Group all candidates by task and present them:

```
━━━ From "<task.title>" (<repo basename>, <relative time>) ━━━
1. <learning summary>
2. <learning summary>
3. <learning summary>

━━━ From "<task.title>" (<repo basename>, <relative time>) ━━━
4. <learning summary>

Approve, edit, or dismiss each learning.
Examples: "approve 1,2,4" "edit 3" "dismiss all" "approve all"
```

Wait for user response. Handle:

- **"approve N,N,N"** or **"approve all"** — mark those candidates as approved
- **"edit N"** — ask the user for the revised text, then mark as approved with new text
- **"dismiss N,N,N"** or **"dismiss all"** — discard those candidates
- Mixed: user can combine in one response, e.g., "approve 1,2 edit 3 dismiss 4"

### Step 6: Write approved learnings

Group approved learnings by `repo_path` (tasks may span multiple repos).

For each repo:

1. Check if `<repo_path>/.claude/rules/learnings.md` exists
2. If it doesn't exist:

   ```bash
   mkdir -p <repo_path>/.claude/rules
   ```

   Write the file with:

   ```markdown
   # Learnings

   - <approved learning 1>
   - <approved learning 2>
   ```

3. If it exists, append each approved learning as a new line:
   ```
   - <approved learning>
   ```

### Step 7: Mark tasks as reviewed

For each task that was processed (whether learnings were found or not):

```bash
touch <task.worktree>/.learnings-reviewed
```

### Step 8: Report

```
✓ Added <N> learnings to <repo>/.claude/rules/learnings.md
✓ Marked <M> tasks as reviewed
```

## Edge Cases

- **Task has no worktree (deleted):** Skip silently — worktree gone means task was deleted
- **JSONL file missing:** Warn and skip that agent, continue with others
- **Very long session (>3MB extracted text):** Already handled in Step 2 parsing — segments
  are processed separately and candidates deduplicated
- **Multiple repos across tasks:** Group by `repo_path`, write to each repo's own
  `.claude/rules/learnings.md`
- **Octomux server not running:** If `curl` to localhost:7777 fails, report:
  "Cannot connect to octomux server at localhost:7777. Is it running?" and stop
- **No agents with session IDs:** Report "No agent sessions found for this task" and mark reviewed
