# `server/` Audit & Optimization Plan

Scope: `server/` directory only. Constraints: no changes to `types.ts` shared exports, DB schema, API contract, tmux session naming, or worktree paths.

---

## HIGH priority

### H1. DRY the task-lookup-404 pattern in `api.ts`

`db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)` followed by `if (!task) { res.status(404)... return }` appears in **13 routes** (lines 275, 358, 451, 491, 512, 534, 555, 586, 615, 644, ...). Same shape every time.

- **Action**: extract `loadTaskOrFail(req, res): Task | null` helper. Routes that need agents/terminals afterward then call existing prepared statements.
- **Impact**: ~40 lines deleted, single source of truth for "task not found" response.

### H2. DRY the "reload task with relations + broadcast" pattern

After mutations (`PATCH /tasks/:id`, `POST /tasks/:id/start`), three lines reload agents + user_terminals and assemble the response object. Duplicated at 442–447 and 472–477.

- **Action**: extract a small `fetchTaskBundle(taskId)` helper that returns `{task, agents, user_terminals}` (or the same shape used by GET `/tasks/:id`). Used by both `PATCH` and `POST /start`.
- **Impact**: removes 2× 5-line blocks, reduces chance of drift when new fields are added to Task.

### H3. Collapse skills/agents/orchestrator error-handling boilerplate

The ENOENT / "not found" / "Invalid skill name" / 500 chain appears in at least 6 routes (lines 946–958, 993–1004, 1012–1024, and simpler variants in `/api/agents/:name`, `/api/agents`, etc.). Every route repeats the 15-line `try/catch` with subtle variations.

- **Action**: add `mapDomainError(err): { status, message }` helper, or a thin `handleRouteError(res, err)`. Map ENOENT → 404, "already exists" → 409, "Invalid" → 400, fallback 500.
- **Impact**: deletes ~60 lines of repeated error mapping; consolidates HTTP status semantics.

### H4. Remove redundant `DELETE FROM agents` in task delete

`api.ts:504` — `DELETE FROM agents WHERE task_id = ?` runs before `DELETE FROM tasks WHERE id = ?`. The `agents` table has `ON DELETE CASCADE` (db.ts:39), as do `permission_prompts` and `user_terminals`. The manual DELETE is dead code that also highlights an inconsistency: `user_terminals` and `permission_prompts` are NOT manually deleted because the ON DELETE CASCADE handles them.

- **Action**: delete the redundant line. Verify cascade works via existing tests (should, since the test passes today with the redundant line).

### H5. Consolidate duplicate `pragma('table_info(agents)')` in db.ts migrations

`db.ts:123-151` reads `table_info(tasks)` once, then `table_info(agents)` **twice** — once as `agentCols`, once as `agentCols2`, interleaved with `tasks` migrations. The second read is stale-reuse prevention, but it's easy to consolidate: run all `ADD COLUMN` migrations in a single pass after one read per table.

- **Action**: refactor to a single `ensureColumn(table, name, ddl)` helper that reads the columns once per table, adds missing. Or inline a sequential series sharing one `agentCols` read.
- **Impact**: smaller surface for migration ordering bugs; easier to audit what columns exist.

### H6. `task-runner.ts`: factor out the "launch claude in a tmux window" sequence

`startTask` (238–253), `addAgent` (292–305), and `resumeTask` (527–548) all build `claude --session-id …` / `claude --resume …` / `claude --continue …` and call `waitForShellReady` + `send-keys` + clean up a prompt tempfile.

- **Action**: extract `launchClaudeInWindow({ target, sessionId, prompt?, resumeSessionId?, worktree, agentId })`. Move prompt-file lifecycle (write, cat-in-command, setTimeout-delete) into the helper. Reduces 3 copies to 1.
- **Impact**: ~40 fewer lines; single place to fix the shell-escape issue in H7; easier to add retry/backoff later.

### H7. Shell-injection risk in claude launch command

`task-runner.ts:243, 298`:
```ts
claudeCmd += ` "$(cat ${promptFile})"`;
```
`promptFile` is `${worktreePath}/.claude-prompt-${agentId}`. `worktreePath` originates from `task.repo_path` (user-supplied via API) joined with `.worktrees/<slug>`. If the repo path contains `"`, `$(`, `` ` ``, or `;`, an attacker with API access can execute arbitrary shell commands in the tmux session.

- **Action**: shell-quote the path, e.g. `"$(cat '${promptFile.replace(/'/g, `'\\''`)}')"`. Or pipe via `--stdin` if claude supports it. Fixed naturally as part of H6.

### H8. Orchestrator prompt tempfile never cleaned up

`orchestrator.ts:60-62`: writes `os.tmpdir()/octomux-orchestrator-prompt.md` and never deletes it. Also the custom-prompt path is only written for *custom* prompts — default uses `claude --agent orchestrator` directly. Single file, so no growth over time, but the file lingers with old content between restarts.

- **Action**: delete the file after `send-keys` (short `setTimeout`), like the agent prompt files. Or use `claude --agent orchestrator` always and skip the temp file by storing custom content in the agents system.
- **Impact**: minor disk hygiene, avoids stale state if orchestrator definition changes.

### H9. `index.ts` startup `resumeTask` promise is unhandled

`index.ts:50`: `resumeTask(task)` is not awaited and the promise return value is discarded. `resumeTask` has internal try/catch so it shouldn't reject, but if the await chain changes in future the unhandled rejection could crash Node.

- **Action**: `resumeTask(task).catch(err => console.error(...))` OR make `recoverTasks` sequential with `await`.
- **Also**: `startOrchestrator().catch(...)` at 69 is correct; mirror that pattern.

### H10. N+1 SQL in `pollTerminalActivity`

`poller.ts:190-228`: for each running task, runs `SELECT * FROM user_terminals WHERE task_id = ?`. Then per-terminal runs one `tmux list-panes`. The SQL part is easily a single query: `SELECT ut.*, t.tmux_session FROM user_terminals ut JOIN tasks t ON t.id = ut.task_id WHERE t.status = 'running' AND t.tmux_session IS NOT NULL`.

- **Action**: collapse to a single JOIN; keep per-terminal tmux call (unavoidable without custom tmux format tricks). Group broadcasts by task_id so we don't over-broadcast.
- **Impact**: one query per poll instead of N+1.

---

## MEDIUM priority

### M1. `pollStatuses` branch duplication

`poller.ts:48-64`: the two `if (status === 'dead' && …)` branches share the identical `UPDATE agents … WHERE task_id = ?` SQL. Could unify:
```ts
const newStatus = task.status === 'setting_up' ? 'error' : 'closed';
const error = task.status === 'setting_up' ? 'Setup interrupted' : null;
```

### M2. Hardcoded `http://localhost:7777` in `hook-settings.ts`

If the user runs `octomux start --port 8080`, hooks still point to 7777 and permissions/activity broadcast silently break. Should read the configured port (e.g., via env var `OCTOMUX_PORT` populated by `index.ts`).

### M3. `waitForShellReady` spawns subprocesses in a tight loop

`task-runner.ts:78-96`: polls `tmux capture-pane -t <target> -p` every 100ms for up to 5s = up to 50 subprocesses per agent. Usually returns in 2-3 iterations. Could use a longer initial sleep (e.g., 300ms) and halve poll rate to 200ms. Marginal, but scales with number of concurrent agent launches in `resumeTask`.

### M4. `api.ts:safeParseJson` type

Returns `Record<string, unknown>` but callers cast `tool_input as string`. Fine, but `tool_input` is typed as `Record<string, unknown>` in `PermissionPrompt` — the API handlers cast to `unknown` indirectly. Tighten the type of the cast target.

### M5. `api.ts:setupRoutes` is a 950-line function

Hard to navigate, hard to test, hard to review. Splitting by feature (`task-routes.ts`, `skill-routes.ts`, `agent-routes.ts`, `orchestrator-routes.ts`, `settings-routes.ts`, `repo-config-routes.ts`) would improve ergonomics but is a larger refactor. **Defer** unless time permits.

### M6. `api.ts` `/api/browse` path-traversal & isolation

No validation that `dirPath` is under any whitelist. Local dashboard trust-level is high, but any XSS → browse-driven exfil is possible. Also serial stat calls — can parallelize with `Promise.all` over `dirEntries`.

### M7. `repo-config.ts` `getOrCreateRepoConfig` double-reads the row

After INSERT, runs `SELECT ... WHERE repo_path = ?` again. `INSERT ... RETURNING *` is supported by better-sqlite3 and avoids the second round-trip.

### M8. `repo-config.ts` fallback base-branch detection is serial

The fallback loop tries `main`, `master`, `staging` sequentially with three separate git execs. Can parallelize with `Promise.all` + first-true. Marginal (only runs on new repo detection).

### M9. `task-runner.ts:slugifyTitle` unicode handling

Non-ASCII titles collapse to empty slugs → `--suffix` branch name. Consider using `.normalize('NFKD').replace(/[̀-ͯ]/g, '')` first to handle accented chars. Low-risk but a real UX issue for non-English users.

### M10. `db.ts` redundant `UPDATE agents SET hook_activity = 'active'` on every start

`db.ts:161-164`: runs on every process start. Safe but redundant when no agents are in `waiting` state. Could be a targeted update only if the `WHERE` matches rows (SQLite runs update on every row; `WHERE` filters at iteration time, so it's actually fine). Low-priority style cleanup only.

### M11. `hooks.ts` calls `getDb()` redundantly

Each handler calls `getDb().prepare(...)` 2-3 times. Since `getDb()` returns a cached singleton, this is a constant-time lookup, but visually noisy. Single `const db = getDb();` at the top of each handler improves readability.

---

## LOW priority

### L1. `api.ts` uses mix of `safeParseJson` return type and `as string` casts

Minor type hygiene.

### L2. `terminal.ts` grouped viewer sessions — magic nanoid(6) suffix

The `-v-${nanoid(6)}` pattern is tested. Could extract to constant `VIEWER_SUFFIX_PREFIX = '-v-'` and reuse.

### L3. `hook-settings.ts` ALLOWED_TOOLS is a large hardcoded list

Could live in a JSON config file to avoid recompile when updating. Not actionable now; stays as constant.

### L4. `startup.ts` uses `process.exit(1)` deep in helpers

Makes unit testing harder. Low impact since this only runs on `octomux start` setup.

### L5. `agents.ts:117` uses `err: any`

Could be `err: NodeJS.ErrnoException`.

### L6. `events.ts broadcast` serializes once, good. No findings.

### L7. `skills.ts:35-41` `ensureDir` duplicates `mkdir(..., recursive: true)` check

`mkdir -p` already handles existing dirs. The `access` check is a round-trip. Not wrong, just redundant.

---

## Execution order

Pick items that are:
1. Independent, small-diff, mechanically verifiable (typecheck + existing tests prove no regressions).
2. Address real risk (H7, H9) before ergonomic wins.

**Planned commits (target: 8–10):**
1. `refactor(server): extract loadTaskOrFail helper` — H1
2. `refactor(server): extract fetchTaskBundle helper` — H2
3. `refactor(server): consolidate domain error mapping in routes` — H3
4. `refactor(server): drop redundant DELETE agents; rely on ON DELETE CASCADE` — H4
5. `refactor(server): consolidate agents table migrations` — H5
6. `fix(server): shell-quote claude prompt file path` — H7
7. `refactor(server): extract launchClaudeInWindow helper` — H6 (builds on H7)
8. `fix(server): handle unhandled promise in startup recoverTasks` — H9
9. `perf(server): eliminate N+1 in pollTerminalActivity` — H10
10. (optional) `refactor(server): unify pollStatuses dead branches` — M1 + `fix(server): clean up orchestrator tempfile` — H8

Verification after each: `bun run typecheck`, `bun run lint`, `bun run test`.

## Items deferred

- **M2** (hardcoded port in hook-settings) — requires threading PORT through to hook installers; worth its own ticket.
- **M5** (splitting `api.ts` into modules) — too large for a single-PR audit pass.
- **M9** (slugify unicode) — separate product decision.
- **L3** (ALLOWED_TOOLS externalization) — no current pain point.
- All other LOW items — polish, not correctness.
