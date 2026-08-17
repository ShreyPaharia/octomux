# Polish + Agent Visibility — Design Spec

**Date:** 2026-05-09
**Author:** brainstorm session
**Status:** approved, ready for implementation

## Goal

Six related improvements to task hygiene and agent visibility. Lands in three independent PRs.

## Phase A — Quick wins (no DB changes)

### A1. Recent folders show basename, not full path

`src/components/fields/RepoPickerField.tsx:204-216`

The recent-repos list currently renders `repo.repo_path` (full absolute path). Replace with the folder basename and move the full path to a `title=` tooltip on the row. If two basenames collide, append the parent folder in muted text.

```tsx
// before
<span className="font-mono text-xs truncate mr-3">{repo.repo_path}</span>

// after
<span className="font-mono text-xs truncate mr-3" title={repo.repo_path}>
  {basename(repo.repo_path)}
  {hasCollision && <span className="text-muted-foreground"> · {parentDir(repo.repo_path)}</span>}
</span>
```

Reuse `repoBasename` (already in `Composer.tsx:48`) — extract to `src/lib/utils.ts` if not there.

**Acceptance:** recent folders display `nucleus`, `octomux-agents`, etc. instead of `/Users/…`. Hovering shows the full path.

### A2. Composer prompt persists across tab switches

`src/components/Composer.tsx`

The chip state (repo, branch, agent, etc.) survives tab switches today because it lives in URL params. The `prompt` `useState` and `errorBanner` are lost when the component unmounts.

Persist `prompt` to `localStorage`:

- Key: `octomux-composer-draft-prompt`
- Read once on mount: `useState(() => localStorage.getItem(KEY) ?? '')`
- Write on every change (debounced ~250ms via `useEffect`)
- Clear on successful submit (after `navigate(...)` in `handleSubmit`)
- Also clear on explicit "intent cleared" (chip × button on `IntentHeader`)

Don't persist `errorBanner` or `submitting` — those are lifecycle state.

**Acceptance:** type a prompt → switch to Tasks → switch back to Home → prompt is still there. Submit a task → prompt clears for the next one.

---

## Phase B — Workflow polish (1 enum-value addition)

### B1. New `archived` workflow status

`server/types.ts:5`

```ts
export type WorkflowStatus =
  | 'backlog'
  | 'planned'
  | 'in_progress'
  | 'human_review'
  | 'pr'
  | 'done'
  | 'archived';

export const WORKFLOW_STATUSES = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
  'archived',
] as const;
```

No DB migration: column is `TEXT NOT NULL DEFAULT 'backlog'` with no CHECK constraint, so the new value is accepted as-is.

Update `WORKFLOW_STATUSES` in any test fixture / type-narrowing site.

### B2. Auto-close on archive transition

`server/api.ts` — inside the `moveTask` handler (around line 1913):

When `body.workflow_status === 'archived'` and `task.runtime_state IN ('running', 'setting_up')`, call `closeTask(task.id)` _before_ the status update. Existing `closeTask` already handles agent stop + tmux teardown; worktree + branch are preserved (so the task can be unarchived back to in_progress later).

### B3. Board UI — hide archived by default + bulk-archive done

`src/components/TaskBoardColumn.tsx` and `src/components/TaskBoard.tsx`

- Add `'archived'` to the column-render filter, but exclude it from the default visible set.
- Add a "Show archived" toggle (probably in the board header next to existing filters in `TaskFilterBar.tsx`). When on, render the archived column at the far right with muted styling.
- On the **Done** column header, add a small action button: **"Archive all (N)"** — disabled when N=0. Calls a new bulk endpoint `POST /api/tasks/archive-done`.

`server/api.ts` — new endpoint:

```ts
app.post('/api/tasks/archive-done', (req, res) => {
  // Find all tasks with workflow_status='done'.
  // For each: if running, await closeTask. Then UPDATE workflow_status='archived'.
  // INSERT a 'transition' row in task_updates for each.
  // Broadcast task:updated for each.
  // Return { archived: number }.
});
```

Single-task archive uses existing `moveTask` API — no new endpoint.

### B4. `Stop` hook → `human_review` transition

`server/hooks.ts` — extend the `POST /api/hooks/stop` handler.

After the existing logic (resolve permission prompts, set `hook_activity = 'idle'`):

```ts
// If task is in_progress with no other running agents, transition to human_review.
const task = getDb()
  .prepare(`SELECT id, workflow_status FROM tasks WHERE id = ?`)
  .get(agent.task_id);
const otherRunning = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM agents WHERE task_id = ? AND status = 'running' AND id != ?`)
  .get(agent.task_id, agent.id);

if (task.workflow_status === 'in_progress' && otherRunning.n === 0) {
  // Update + write task_updates row + broadcast + fireHook('workflow_status_changed', ...)
}
```

Notes:

- Skip if there are pending permission prompts (they were just resolved above — re-query AFTER the transaction).
- Skip if other agents on the same task are still `running` (avoid premature transitions in multi-agent tasks).
- The transition note is `auto: agent stopped` (matches poller.ts conventions).

**Acceptance:** start a task → agent finishes → board shows it in **Human Review** within 1-2 seconds.

### B5. Server-side title + description generation

New file `server/title-gen.ts`:

```ts
export async function generateTitleAndDescription(
  initialPrompt: string,
): Promise<{ title: string; description: string }> {
  // If process.env.ANTHROPIC_API_KEY is unset, fall back immediately.
  // Else: call Haiku (claude-haiku-4-5-20251001) with prompt:
  //   "Given this task description, return JSON {title, description}.
  //    title: ≤50 chars, imperative ('Add X', 'Fix Y'), no trailing period.
  //    description: 1 sentence ≤140 chars summarizing the goal."
  // Hard timeout 5s. On any error, fall back.
  // Fallback: title = first line ≤80 chars, description = full prompt.
}
```

Use the official `@anthropic-ai/sdk` (already in `package.json`? If not, add to dependencies). Keep prompt-caching enabled per the user's claude-api skill notes.

`server/api.ts` — `createTask` handler: after validating, if `body.initial_prompt` is set and either `title` or `description` is missing, call `generateTitleAndDescription(body.initial_prompt)` and merge.

`src/components/Composer.tsx` — stop deriving the title client-side when `initial_prompt` is sent. Just pass `initial_prompt` and let the server fill `title`/`description`. (The `payload.title = deriveTitleFromPrompt(...)` lines should remain only as a fallback.)

**Acceptance:** without an API key, behaviour is unchanged. With a key, sidebar / board cards show clean titles like "Fix archive auto-close" instead of "Fix archive button so that when…".

---

## Phase C — Toggleable hooks + Haiku summarizer (1 new table)

### C1. `hook_settings` table

`server/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS hook_settings (
  scope    TEXT NOT NULL,
  key      TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key)
);
```

Conventions:

- `scope`: `'global'` (for `~/.octomux/hooks/`), `'repo:<absolute-path>'` (for `<repo>/.octomux/hooks/`), or `'builtin'` (for built-in hooks).
- `key`: `<event>/<script-basename>` for FS hooks, `'summarize-progress'` for the built-in.
- Missing row = enabled (back-compat). Built-in summarizer is the exception — defaults disabled.

### C2. Hook dispatcher honours `enabled` flag

`server/hook-dispatcher.ts`:

In the function that iterates discovered scripts (around `discoverScripts`), wrap each script invocation with:

```ts
const enabled = isHookEnabled(scope, `${event}/${path.basename(script)}`);
if (!enabled) {
  logger.debug({ scope, key, event }, 'hook skipped (disabled)');
  continue;
}
```

`isHookEnabled` is a cached lookup against `hook_settings` (cache invalidated when toggled via API). Treat missing rows as enabled.

### C3. Built-in `summarize-progress` hook

New file `server/summarize.ts`:

```ts
export async function summarizeAgentProgress(taskId: string, agentId: string): Promise<void> {
  // 1. Check hook_settings: enabled && ANTHROPIC_API_KEY set. Return if not.
  // 2. Pull last ~30 task_updates rows (kind IN ('summary','transition','note'))
  //    + agent's recent permission_prompts (resolved in last 10 min).
  //    Build a compact transcript ≤4k chars.
  // 3. Haiku call: "Summarize what this agent just did in one sentence,
  //    ≤120 chars, present tense, no preamble."
  // 4. UPDATE tasks SET current_summary = ?, current_summary_updated_at = datetime('now').
  // 5. broadcast({ type: 'task:updated', payload: { taskId } }).
  // 6. Fire hook 'summary_updated'.
  // 7. Hard timeout 8s. Errors logged + swallowed — never bubble.
}
```

`server/hooks.ts` — at the end of the `POST /api/hooks/stop` handler (after the workflow_status transition added in B4), call:

```ts
void summarizeAgentProgress(agent.task_id, agent.id); // fire-and-forget
```

### C4. API for hook registry + toggle

`server/api.ts`:

```
GET  /api/hooks/registry          → { hooks: HookRegistryEntry[] }
PATCH /api/hooks/registry/:scope/:key  body: { enabled: boolean }
```

`HookRegistryEntry`:

```ts
{
  scope: 'global' | 'repo:<path>' | 'builtin',
  key: string,
  event: string | null,    // null for built-ins
  script_path: string | null,
  description: string | null,  // built-ins only
  enabled: boolean,
  last_run_at: string | null,
  last_exit_code: number | null,
}
```

`GET /api/hooks/registry` does:

1. Discover all FS hooks across `~/.octomux/hooks/` and every active task's repo `.octomux/hooks/`.
2. Add the built-in `summarize-progress` entry with its description text.
3. Join with `hook_settings` for `enabled`.
4. Pull `last_run_at` / `last_exit_code` from existing hook log files (parse as in `cli/src/commands/hooks-list.ts`).

### C5. Settings UI — new HOOKS section

`src/pages/SettingsPage.tsx`:

- Add `'hooks'` to `SectionId` and `NAV_ITEMS` (between `'skills'` and `'repositories'`).
- New `HooksSection` component renders three groups: **Built-in**, **Global**, **Repo**.
- Each row uses the existing `SettingRow` + `ToggleSwitch` components.
- The `summarize-progress` row has an extra warning if `ANTHROPIC_API_KEY` is unset: "Set ANTHROPIC_API_KEY to enable Haiku summaries."
- Calls `PATCH /api/hooks/registry/...` on toggle. Optimistic UI.

**Acceptance:** Settings → HOOKS shows all hooks with toggles. Disabling `notify-slack.sh` skips it on next event. Enabling `summarize-progress` causes `current_summary` to update with a narrative line within ~5s of agent stop.

---

## Out of scope

- Backfill: existing tasks keep their current titles. Title-gen runs only on new tasks.
- Per-task hook overrides (only global toggle).
- Live progress mid-task (only on Stop).
- Re-summarising on demand from the UI.
- Summarizer for the `current_summary` field replacing the existing tool-name heartbeat — they coexist; Haiku writes happen on Stop only, the mechanical PostToolUse path is unchanged.

## Test expectations

Each phase should add tests at the appropriate layer:

- **A1:** unit test for basename helper + RTL test for the recent list.
- **A2:** RTL test that `localStorage` is read on mount, written on change, cleared on submit.
- **B1-B3:** API test for `/api/tasks/archive-done` (running task is closed, status flips); component test for the bulk button + show-archived toggle.
- **B4:** hook-dispatcher integration test for Stop → human_review transition (covers happy path, multi-agent skip, pending-prompt skip).
- **B5:** unit test for `title-gen.ts` fallback path (no key); integration test for `createTask` calling the generator. Mock the SDK.
- **C1-C2:** db migration test; dispatcher test that disabled hook is skipped.
- **C3:** unit test for `summarize.ts` (mocked SDK).
- **C4-C5:** API test for registry GET/PATCH; component test for HooksSection toggle.

## Verification

- `bun run typecheck`
- `bun run test`
- `bun run lint`
- Smoke E2E in `e2e/` for archive flow and hooks settings page.

## Phasing dependencies

- **A** is independent.
- **B** depends on nothing new in **A** but should land first because **C4** reuses the `task_updates` row written by **B4**.
- **C** depends on **B4**'s Stop-handler hook point (where `summarizeAgentProgress` is called).
