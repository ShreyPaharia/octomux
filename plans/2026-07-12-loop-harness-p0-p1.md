# Loop Harness (P0 + P1) Implementation Plan

> **For agentic workers:** Implement task-by-task. Each task is one octomux task → one PR targeting
> `next`. Steps use checkbox (`- [ ]`) syntax. Follow repo conventions in `CLAUDE.md` exactly
> (pino `childLogger`, `getDb()`, template-literal SQL with single-quoted `'now'`, vitest
> `it.each`, `NODE_ENV=test`, conventional commits, Prettier single-quote/100-col).

**Goal:** Ship octomux's native, observable, fleet-isolated Ralph-loop harness: a task can run its
agent in a `while`-style loop that respawns with fresh context each iteration, verifies with a shell
command, terminates safely, and streams an Iteration Ledger to the dashboard.

**Architecture:** A loop is a controller _around_ the existing agent lifecycle (task-runner + tmux),
not a new runtime. The engine drives: spawn clean → detect turn-end → auto-commit → run verify →
check termination → respawn or stop. Controller state persists in new `loop_runs` /
`loop_iterations` tables. The agent signals completion via a fixed-shape `octomux emit` HTTP
callback. FE reuses the existing diff/terminal/list machinery.

**Tech Stack:** Express 5, better-sqlite3 (WAL, forward-only migrations), node-pty + tmux, ws,
React 19 + React Router 7 + Tailwind 4, nanoid(12), vitest, Playwright.

## Global Constraints

- Node 24 LTS; bun as package manager/runner; tsx dev server.
- DB migrations are **forward-only**; never edit an existing migration — append a new one.
- All `server/` logging via `childLogger('<module>')`; **never** `console.*`. Every loop log line
  includes `task_id` (and `loop_run_id` / `agent_id` where relevant).
- SQLite `datetime('now')` needs single-quoted `'now'` — use template literals.
- Conventional commits, kebab-case scopes, 100-char header. **No `Co-Authored-By` lines.**
- PRs target **`next`**, not `main`. Rebase onto `origin/next` before opening.
- tmux `base-index` varies per user — query actual window index, never hardcode 0.
- `CLAUDE_INIT_DELAY` is 0 in test env; keep new sleeps guarded so tests stay fast.

---

## Task 1 (P0): Fresh-context respawn primitive + poller exemption

**Why first:** This is the least-proven, load-bearing claim (spec §3.3, §8). Everything else is
downstream. Ship it as a standalone, reviewable primitive with a test proving a single-window tmux
session survives repeated respawns and the status poller leaves loop tasks alone.

**Files:**

- Modify: `server/task-runner.ts` — add `respawnAgentFresh(task, agent)`.
- Modify: `server/poller.ts` — exempt loop tasks from `pollStatuses` teardown.
- Modify: `server/types.ts` — add `'looping'` to the runtime-state union.
- Modify: `server/db.ts` — append a migration allowing `runtime_state = 'looping'` (if a CHECK
  constraint exists) — otherwise no schema change needed; confirm by reading the table DDL.
- Test: `server/task-runner.respawn.test.ts`, extend `server/poller.test.ts`.

**Interfaces:**

- Produces: `respawnAgentFresh(task: Task, agent: Agent): Promise<Agent>` — creates a **new** tmux
  window in the task's existing session, launches the harness fresh (`harness.newSessionId()`, **no**
  `--resume`), waits for shell-ready, then kills the **old** window. Returns the new agent row (new
  `harness_session_id`, same `task_id`). Guarantees the session never has zero windows.
- Produces: runtime state `'looping'` — a task in this state is skipped by `pollStatuses`.

- [ ] **Step 1: Read the exact current mechanics.** Read `server/task-runner.ts` for `addAgent`
      (new-window + launch), `stopAgent` (kill-window), the default launch command path
      (`harness.newSessionId()`, no `--resume`), and `waitForShellReady`. Read `server/poller.ts`
      `pollStatuses` (the `has-session` check that flips dead tasks to `idle` + marks agents `stopped`).
      Note the real function/param names; the steps below use them.

- [ ] **Step 2: Write the failing respawn test.** In `server/task-runner.respawn.test.ts`, mock
      `child_process` (execFile/spawn) and `fs` per existing task-runner test patterns
      (`server/test-helpers.ts`, `default: mocked` for fs). Assert that `respawnAgentFresh`:
      (a) issues the tmux `new-window` **before** any `kill-window` (assert call ordering via
      `findExecCall`/`countExecCalls`); (b) launches with a fresh session id and no `--resume` flag;
      (c) returns an agent whose `harness_session_id` differs from the input.

- [ ] **Step 3: Run it — verify it fails.** `bun run test -- task-runner.respawn` → FAIL
      (function not defined).

- [ ] **Step 4: Implement `respawnAgentFresh`.** Compose from the verified `addAgent`/`stopAgent`
      building blocks: create new window + launch fresh, `waitForShellReady`, then kill the old window.
      Update the agent row (`harness_session_id`), `broadcast(...)`, `logger.info({ task_id,
agent_id, operation: 'respawn_fresh' }, ...)`.

- [ ] **Step 5: Run it — verify it passes.** `bun run test -- task-runner.respawn` → PASS.

- [ ] **Step 6: Write the failing poller-exemption test.** Extend `server/poller.test.ts`: a task in
      `runtime_state='looping'` whose `has-session` check fails must **not** be flipped to `idle` and its
      agents must **not** be marked `stopped`.

- [ ] **Step 7: Run it — verify it fails.** `bun run test -- poller` → FAIL.

- [ ] **Step 8: Add `'looping'` to the runtime-state union** in `server/types.ts`; if the DB table
      has a CHECK constraint on `runtime_state`, append a forward-only migration in `server/db.ts`
      widening it. Exempt `'looping'` tasks in `pollStatuses` (add to the skip predicate alongside the
      existing `tmux_session IS NOT NULL` guard).

- [ ] **Step 9: Run it — verify it passes.** `bun run test -- poller` → PASS.

- [ ] **Step 10: Full gate.** `bun run typecheck && bun run lint && bun run test` → all green.

- [ ] **Step 11: Commit + open PR.**

```bash
git commit -m "feat(loop): fresh-context respawn primitive + poller exemption for loop tasks"
```

Open PR targeting `next`. PR body: what respawn ordering guarantees, why loop tasks are poller-exempt.

**Acceptance:** respawn ordering test passes; loop-task poller exemption test passes; full gate green.

---

## Task 2 (P1a): Loop persistence + `octomux emit` completion callback

**Depends on:** Task 1 merged.

**Why standalone:** The emit endpoint + tables are independently testable (POST → validated →
persisted) without the engine. This is the fixed `{status, reason}` callback of spec §3.1 — **no
JSON-Schema/ajv engine.**

**Files:**

- Modify: `server/db.ts` — append migration: `loop_runs`, `loop_iterations`.
- Create: `server/loop-runs.ts` — CRUD for loop runs/iterations (mirror `review-runs.ts` shape).
- Modify: `server/api.ts` — add `POST /api/loops/:runId/emit` (hook_token auth) + read routes.
- Modify: `server/hook-token.ts` usage — reuse existing per-agent token verification.
- Create: `cli/src/commands/emit.ts` — `octomux emit --run <id> --status <s> --reason <text>`.
- Modify: `cli/src/index.ts` — register `emit`.
- Test: `server/loop-runs.test.ts`, `server/api.loops-emit.test.ts`, `cli/src/commands/emit.test.ts`.

**Interfaces:**

- Produces (DB): `loop_runs(id TEXT PK, task_id TEXT, spec_json TEXT, status TEXT, iteration INTEGER,
max_iterations INTEGER, budget_json TEXT, termination_reason TEXT, created_at, updated_at)`;
  `loop_iterations(id TEXT PK, loop_run_id TEXT, n INTEGER, sha_from TEXT, sha_to TEXT,
verify_passed INTEGER, tokens INTEGER, emit_status TEXT, emit_reason TEXT, created_at)`.
- Produces (module `server/loop-runs.ts`): `createLoopRun(input): LoopRun`,
  `getLoopRun(id): LoopRun | undefined`, `listLoopRuns(): LoopRun[]`,
  `appendIteration(loopRunId, row): LoopIteration`, `recordEmit(loopRunId, {status, reason}): void`.
- Produces (HTTP): `POST /api/loops/:runId/emit` — bearer = agent `hook_token`; body
  `{ status: 'done'|'blocked'|'needs_human', reason: string }`; hand-validated (reject 4xx on bad
  enum / missing reason); persists via `recordEmit`; `broadcast({ type: 'loop:emit', ... })`.
- Produces (CLI): `octomux emit --run <id> --status <s> --reason <text>` → POST to
  `hookBaseUrl()/api/loops/<id>/emit` with the token from env.

- [ ] **Step 1: Read patterns.** `server/review-runs.ts` (module shape), `server/db.ts` (how prior
      migrations append), `server/hook-token.ts` + `server/hooks.ts` (per-agent `hook_token` verify),
      `server/hook-base-url.ts`, an existing `cli/src/commands/*.ts` + `cli/src/client.ts`.

- [ ] **Step 2: Failing DB/module test.** `server/loop-runs.test.ts` (in-memory DB via
      `createTestDb()`): `createLoopRun` inserts and round-trips; `appendIteration` increments `n`;
      `recordEmit` sets `loop_runs.status` + latest iteration's `emit_*`.

- [ ] **Step 3: Run → FAIL.** `bun run test -- loop-runs`.

- [ ] **Step 4: Append migration + implement `server/loop-runs.ts`** (template-literal SQL,
      `datetime('now')`, `childLogger('loop-runs')`).

- [ ] **Step 5: Run → PASS.** `bun run test -- loop-runs`.

- [ ] **Step 6: Failing emit-endpoint test.** `server/api.loops-emit.test.ts` (supertest against
      `createApp()`): valid token + valid body → 200 + persisted; bad status enum → 400; missing/blank
      reason → 400; wrong/absent token → 401.

- [ ] **Step 7: Run → FAIL.** `bun run test -- api.loops-emit`.

- [ ] **Step 8: Implement the route** in `server/api.ts` reusing the existing token verify; add read
      routes `GET /api/loops` and `GET /api/loops/:runId` (run + iterations).

- [ ] **Step 9: Run → PASS.** `bun run test -- api.loops-emit`.

- [ ] **Step 10: Failing CLI test + implement.** `cli/src/commands/emit.test.ts`: builds the correct
      POST (url, bearer, body) from flags. Implement `emit.ts`, register in `cli/src/index.ts`.

- [ ] **Step 11: Run → PASS.** `cd cli && bun run test -- emit` (or repo test runner).

- [ ] **Step 12: Full gate + commit + PR.** `bun run typecheck && bun run lint && bun run test`.

```bash
git commit -m "feat(loop): loop_runs/loop_iterations tables + octomux emit completion callback"
```

PR targets `next`.

**Acceptance:** tables migrate forward-only; emit endpoint validates the fixed payload and persists;
CLI posts correctly; full gate green.

---

## Task 3 (P1b): Loop engine — iteration orchestration, verify, termination

**Depends on:** Tasks 1 & 2 merged.

**Files:**

- Create: `server/loop-engine.ts` — the controller.
- Create: `server/loop-verify.ts` — run the `verify` shell command, return pass/fail + output.
- Modify: `server/hooks.ts` — loop-aware Stop path that **bypasses** the `in_progress→human_review`
  transition, `task_updates` insert, `fireHook('workflow_status_changed')`, and the summarizer when
  the agent's task is a loop.
- Modify: `server/task-runner.ts` — auto-commit helper at iteration boundary (reuse the
  `preflightWorktree` `git add -A` + commit pattern).
- Create: `cli/src/commands/loop-start.ts` — `octomux loop start` (spec file, `--verify`,
  `--max-iterations`, `--budget`).
- Test: `server/loop-engine.test.ts`, `server/loop-verify.test.ts`, `server/hooks.loop.test.ts`.

**Interfaces:**

- Consumes: `respawnAgentFresh` (Task 1); `createLoopRun`/`appendIteration`/`recordEmit` and the
  `loop_runs`/`loop_iterations` schema (Task 2); the diff-range SHA machinery.
- Produces: `startLoop(taskId, spec: LoopSpec): Promise<LoopRun>` where
  `LoopSpec = { prompt: string; verify: string; maxIterations: number;
budget?: { tokens?: number; timeMs?: number }; noProgress?: { afterIters: number } }`.
  Sets task `runtime_state='looping'`, drives iterations, persists each to `loop_iterations`,
  terminates on **any** of: agent `emit.status==='done'` **AND** verify passes; `maxIterations`;
  `budget` exhausted (checked **before** each respawn); `noProgress` (empty `sha_from..sha_to` for
  N consecutive iterations). On `blocked`/`needs_human`, pause the loop (status set, no respawn).
- Produces: `runVerify(cwd, cmd): Promise<{ passed: boolean; output: string }>` (exit 0 == pass).

- [ ] **Step 1: Read.** `server/hooks.ts` Stop-hook handler (the human_review transition + fireHook +
      summarizer block); `preflightWorktree` in `task-runner.ts`; `server/diff-range.ts` (how a commit
      range is computed) for the sha_from/sha_to capture.

- [ ] **Step 2: Failing verify test.** `server/loop-verify.test.ts` (mock execFile): exit 0 →
      `{passed:true}`; non-zero → `{passed:false, output}` including stderr.

- [ ] **Step 3: Run → FAIL; implement `loop-verify.ts`; run → PASS.**

- [ ] **Step 4: Failing loop-stop-path test.** `server/hooks.loop.test.ts`: when the Stop hook fires
      for an agent whose task is a loop, assert **no** `human_review` transition, **no**
      `task_updates` row, **no** `fireHook('workflow_status_changed')`, **no** summarizer call. Non-loop
      tasks keep existing behavior (table-driven `it.each`).

- [ ] **Step 5: Run → FAIL; implement the loop-aware branch in `hooks.ts` (guard on the task being a
      loop); run → PASS.**

- [ ] **Step 6: Failing engine test.** `server/loop-engine.test.ts` (in-memory DB + mocked
      child_process/tmux): drive a 3-iteration scenario — iterations 1–2 emit `done` but verify fails →
      respawn; iteration 3 emits `done` and verify passes → stop with `termination_reason='done'`.
      Assert `loop_iterations` has 3 rows with correct `verify_passed` and sha ranges, and that
      `respawnAgentFresh` was called between iterations. Add cases: `maxIterations` cap stops the loop;
      empty-diff for `noProgress.afterIters` stops with `termination_reason='no_progress'`; `budget`
      check runs before respawn.

- [ ] **Step 7: Run → FAIL.** `bun run test -- loop-engine`.

- [ ] **Step 8: Implement `startLoop`** in `server/loop-engine.ts`: set `looping`; per iteration —
      spawn/await turn-end (via the loop Stop path), auto-commit boundary, capture `sha_from..sha_to`,
      `runVerify`, `appendIteration`, evaluate termination, else `respawnAgentFresh`. Enforce
      budget/maxIterations **before** respawn. `childLogger('loop-engine')` with `task_id`/`loop_run_id`.

- [ ] **Step 9: Run → PASS.** `bun run test -- loop-engine`.

- [ ] **Step 10: CLI `loop start`.** Implement `cli/src/commands/loop-start.ts` + register; a test
      asserting it POSTs to a `POST /api/loops` create route (add that route in `api.ts`, calling
      `startLoop`). Keep the agent prompt templated with `--run <id>` per spec §3.1.

- [ ] **Step 11: Full gate + commit + PR.**

```bash
git commit -m "feat(loop): loop engine with verify, auto-commit, layered termination + loop stop path"
```

PR targets `next`.

**Acceptance:** engine drives fresh-context iterations end to end in tests; loop Stop path bypasses
human_review/integrations; all four termination exits covered; full gate green.

---

## Task 4 (P1c): Frontend — `/loops`, Iteration Ledger, control strip, New Loop form

**Depends on:** Tasks 2 & 3 merged (needs `GET /api/loops`, `GET /api/loops/:id`, create route).

**Files:**

- Modify: `src/App.tsx` — add `<Route path="/loops">` + `/loops/:id` (concrete routes, per spec
  §10.3; **no** generic registry yet).
- Create: `src/pages/LoopsPage.tsx` (feed), `src/pages/LoopDetailPage.tsx` (ledger + control strip).
- Create: `src/components/loop/IterationLedger.tsx`, `src/components/loop/LoopControlStrip.tsx`,
  `src/components/loop/NewLoopDialog.tsx`.
- Modify: `src/lib/api.ts` — `listLoops`, `getLoop`, `createLoop`, `stopLoop`.
- Test: `src/pages/LoopsPage.test.tsx`, `src/pages/LoopDetailPage.test.tsx`,
  `src/components/loop/IterationLedger.test.tsx`.

**Interfaces:**

- Consumes: `GET /api/loops`, `GET /api/loops/:id` (run + iterations), `POST /api/loops` (create),
  the loop `stop` route.
- Reuse (do not rebuild): `DiffViewer` + the `DiffRange`/`diffRangeToParam` machinery for each
  iteration's `sha_from..sha_to` diff; `TerminalView`/`AgentTabs` for the live-agent tab;
  `TaskActivityPanel` layout as the ledger timeline base; `components/fields/*` for the New Loop form.

- [ ] **Step 1: Read.** `src/lib/api.ts` (client pattern), `src/pages/ReviewsPage.tsx` +
      `useReviewQueue.ts` (feed pattern), `src/components/DiffViewer.tsx` + `DiffRangePicker.tsx`
      (`diffRangeToParam` usage), `src/components/TaskActivityPanel.tsx`, `src/test-helpers.tsx`
      (`renderWithRouter`, `mockApi`).

- [ ] **Step 2: Failing ledger test.** `IterationLedger.test.tsx`: given N iteration rows, renders N
      timeline entries showing iteration #, verify pass/fail badge, tokens; clicking a row reveals its
      diff (mock the diff fetch keyed to `sha_from..sha_to`).

- [ ] **Step 3: Run → FAIL; implement `IterationLedger.tsx` (diff body via `DiffViewer` + range);
      run → PASS.**

- [ ] **Step 4: Failing LoopsPage test.** Renders the loop feed from `listLoops` with status + current
      `iteration / max`. Implement `LoopsPage.tsx`; run → PASS.

- [ ] **Step 5: Failing LoopDetailPage test.** Renders control strip (`iteration N / max`, budget
      consumed, termination reason, stop button) + the ledger + a session tab. Implement
      `LoopDetailPage.tsx` + `LoopControlStrip.tsx`; run → PASS.

- [ ] **Step 6: New Loop form.** `NewLoopDialog.tsx` (prompt/spec, `verify` command, max-iterations,
      budget) → `createLoop`. Add routes to `App.tsx` and nav entry. Add `src/lib/api.ts` methods.

- [ ] **Step 7: Full gate + commit + PR.** `bun run typecheck && bun run lint && bun run test`.

```bash
git commit -m "feat(loop): /loops routes, iteration ledger, control strip, new-loop form"
```

PR targets `next`.

**Acceptance:** feed + detail render from the API; ledger shows per-iteration diff via existing
`DiffRange`; New Loop form creates a run; full gate green.

---

## Self-Review (against spec §3.1, §3.3, §9 P0/P1, §10)

- **P0 respawn spike** → Task 1 (new-window-before-kill ordering, poller exemption). ✔
- **`loop_runs`/`loop_iterations` tables** → Task 2. ✔
- **Fixed `{status, reason}` emit, no ajv** → Task 2 (hand-validated). ✔
- **Auto-commit each boundary** → Task 3 Step 8. ✔
- **Verify = one shell command, exit 0** → Task 3 (`loop-verify.ts`). ✔
- **Layered termination (done+verify / maxIterations / budget-before-respawn / noProgress)** →
  Task 3 Step 6/8. ✔
- **Loop Stop path bypasses human_review + integrations + summarizer** → Task 3 Step 4-5. ✔
- **Crash/resume note** → deferred within P1: `startLoop` is restartable from `loop_runs` state; a
  full server-restart resume path is called out as a follow-up in the Task 3 PR description (not
  blocking the reference build).
- **FE: concrete `/loops`, ledger via `DiffRange`, control strip, New Loop form** → Task 4. ✔
- **No registry / no generic `/w/:kind`** → correctly absent (spec §4 = P3). ✔

**Type consistency:** `LoopSpec`, `LoopRun`, `LoopIteration`, `respawnAgentFresh`, `startLoop`,
`runVerify`, `recordEmit`, `appendIteration` used consistently across Tasks 2–4.

**Known deliberate deferral (surfaced, not silent):** full server-restart resume of an in-flight
loop is documented as a follow-up, not built in P1.
