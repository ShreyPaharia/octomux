# Workflow Consolidation — Wave 1 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Two tracks (A and B)
> have **disjoint file sets** and run in parallel. Do not edit a file outside your track's list.

**Goal:** Every workflow run finishes with a readable result (Track B), and every workflow run is
visible in one `/runs` feed instead of a nav row per kind (Track A).

**Architecture:** Track B wires `finishRun` into the four run shapes that never call it, writing a
shared `RunResult` envelope into the existing `runs.result_json` column. Track A adds an all-kinds
runs listing, builds `/runs` on top of it, deletes five surfaces, and filters the Tasks board to
manual work. No DB migration.

**Tech Stack:** Express 5, better-sqlite3, vitest + supertest, React 19, Tailwind 4, React Router 7.

**Spec:** `spec/workflow-consolidation.md` (this implements P1 + P2 of §8; P3–P5 are a later wave).

## Global Constraints

- Conventional commits, kebab-case scopes, 100 char header max: `feat(runs): ...`, `fix(loop): ...`
- **No `Co-Authored-By` lines in commit messages.**
- **Do not commit unless the plan step says to.** Leave work staged-but-uncommitted otherwise.
- Prettier: single quotes, trailing commas, 100 char width, semicolons.
- All `server/` logging via `childLogger('<module>')` — never `console.*`. Lifecycle logs include
  `task_id` / `run_id`.
- SQLite `datetime('now')` needs single-quoted `'now'` — use template literals, not plain strings.
- better-sqlite3 is synchronous — no `await` on DB calls.
- Tests: vitest, `it.each()` table-driven where there are ≥3 cases, `createTestDb()` for DB
  isolation, supertest against `createApp()` for routes.
- Run `bun run typecheck` and `bun run test` before the final commit of each task.

## Track ownership — do not cross these lines

| Track                   | Owns                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A**                   | `src/**`, `server/repositories/runs.ts`, `server/repositories/tasks.ts`, `server/routes/workflow-runs.ts`, `server/routes/tasks.ts`                                      |
| **B**                   | `server/workflows/**`, `server/services/*-service.ts`, `server/task-engine/loop/**`, `server/agent-session/**`, `server/routes/loops.ts`, `server/routes/pr-extracts.ts` |
| **Shared, pre-written** | `packages/types/src/index.ts` — **already done before dispatch (Task 0). Neither track modifies it.**                                                                    |

---

## Task 0: Shared `RunResult` envelope (DONE BEFORE DISPATCH — reference only)

Already committed to `packages/types/src/index.ts`. Both tracks consume it; neither edits it.

```ts
/** Universal run-result envelope. Every workflow finishes its run with this shape;
 *  kind-specific `output` schemas are merged in alongside these keys. */
export interface RunResult {
  outcome: 'done' | 'blocked' | 'failed';
  summary: string;
  links?: { label: string; url: string }[];
  [key: string]: unknown;
}

export const RUN_RESULT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'string', minLength: 1 },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
} as const;

/** Type guard for rendering: `runs.result_json` is untrusted TEXT. */
export function isRunResult(v: unknown): v is RunResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.outcome === 'done' || o.outcome === 'blocked' || o.outcome === 'failed') &&
    typeof o.summary === 'string'
  );
}
```

---

# TRACK A — Runs feed, nav consolidation, board filter

## Task A1: All-kinds runs listing + `GET /api/runs`

**Files:**

- Modify: `server/repositories/runs.ts` (add `listAllRuns`, after `listRunsForWorkflow` at :91)
- Modify: `server/routes/workflow-runs.ts` (add route)
- Test: `server/repositories/runs.test.ts`, `server/routes/workflow-runs.test.ts`

**Interfaces:**

- Consumes: existing `LIST_WITH_EFFECTIVE_STATUS_SQL` (`runs.ts:85`), `RunRow` (`runs.ts:12`)
- Produces: `listAllRuns(limit?: number): Array<RunRow & { effective_status: string }>` and
  `GET /api/runs` → `{ runs: Array<RunRow & { effective_status: string }> }`

- [ ] **Step 1: Write the failing repository test**

Append to `server/repositories/runs.test.ts`:

```ts
describe('listAllRuns', () => {
  it('returns runs across all kinds, newest first', () => {
    insertRun({ workflowKind: 'doc-drift', trigger: 'cron' });
    insertRun({ workflowKind: 'weekly-update', trigger: 'cron' });

    const rows = listAllRuns();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.workflow_kind).sort()).toEqual(['doc-drift', 'weekly-update']);
    expect(rows[0]).toHaveProperty('effective_status');
  });

  it('honours the limit argument', () => {
    insertRun({ workflowKind: 'doc-drift', trigger: 'cron' });
    insertRun({ workflowKind: 'doc-drift', trigger: 'cron' });

    expect(listAllRuns(1)).toHaveLength(1);
  });
});
```

Add `listAllRuns` to the existing import from `./runs.js` at the top of that file.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- server/repositories/runs.test.ts`
Expected: FAIL — `listAllRuns is not a function`.

- [ ] **Step 3: Implement**

In `server/repositories/runs.ts`, directly after `listRunsForWorkflow`:

```ts
/** Every run across all kinds, newest first. Backs the unified /runs feed. */
export function listAllRuns(limit = 200): Array<RunRow & { effective_status: string }> {
  return getDb()
    .prepare(`${LIST_WITH_EFFECTIVE_STATUS_SQL} ORDER BY runs.started_at DESC LIMIT ?`)
    .all(limit) as Array<RunRow & { effective_status: string }>;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- server/repositories/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Append to `server/routes/workflow-runs.test.ts` (match the file's existing `createApp()` setup):

```ts
it('GET /api/runs returns runs across all kinds', async () => {
  insertRun({ workflowKind: 'doc-drift', trigger: 'cron' });
  insertRun({ workflowKind: 'reviewer', trigger: 'github' });

  const res = await request(createApp()).get('/api/runs').expect(200);

  expect(res.body.runs).toHaveLength(2);
  expect(res.body.runs[0]).toHaveProperty('workflow_kind');
  expect(res.body.runs[0]).toHaveProperty('effective_status');
});
```

- [ ] **Step 6: Run it and confirm it fails (404)**

Run: `bun run test -- server/routes/workflow-runs.test.ts`
Expected: FAIL — 404, route not registered.

- [ ] **Step 7: Implement the route**

In `server/routes/workflow-runs.ts`, above the existing `/api/workflows/:kind/runs` handler at :21:

```ts
router.get('/api/runs', (_req: Request, res: Response) => {
  res.json({ runs: listAllRuns() });
});
```

Add `listAllRuns` to the existing `../repositories/runs.js` import.

- [ ] **Step 8: Run tests + typecheck**

Run: `bun run test -- server/routes/workflow-runs.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add server/repositories/runs.ts server/repositories/runs.test.ts \
        server/routes/workflow-runs.ts server/routes/workflow-runs.test.ts
git commit -m "feat(runs): add all-kinds runs listing and GET /api/runs"
```

---

## Task A2: `/runs` page with kind filter and result card

**Files:**

- Create: `src/pages/RunsPage.tsx`, `src/components/runs/RunResultCard.tsx`
- Modify: `src/lib/api/workflowsApi.ts` (add `listAllRuns`), `src/App.tsx` (add `/runs` route)
- Test: `src/pages/RunsPage.test.tsx`, `src/components/runs/RunResultCard.test.tsx`

**Interfaces:**

- Consumes: `GET /api/runs` from A1; `isRunResult` / `RunResult` from `@octomux/types`
- Produces: `RunsPage` default export; `RunResultCard({ result }: { result: RunResult })`

- [ ] **Step 1: Write the failing result-card test**

`src/components/runs/RunResultCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { RunResultCard } from './RunResultCard';

describe('RunResultCard', () => {
  it('renders the summary and outcome', () => {
    render(<RunResultCard result={{ outcome: 'done', summary: 'Fixed 3 doc drifts' }} />);
    expect(screen.getByText('Fixed 3 doc drifts')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('renders links as anchors', () => {
    render(
      <RunResultCard
        result={{
          outcome: 'done',
          summary: 'x',
          links: [{ label: 'PR #12', url: 'https://e/12' }],
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'PR #12' })).toHaveAttribute('href', 'https://e/12');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- src/components/runs/RunResultCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RunResultCard`**

`src/components/runs/RunResultCard.tsx`. Match the glass-panel styling used in
`src/components/task-detail/TaskActivityPanel.tsx` (`rounded-2xl border border-glass-edge
bg-glass-l2`). Render `outcome` as a small pill, `summary` as body text, `links` as a row of
anchors with `target="_blank" rel="noreferrer"`.

```tsx
import type { RunResult } from '@octomux/types';

const OUTCOME_TONE: Record<RunResult['outcome'], string> = {
  done: 'bg-emerald-500/15 text-emerald-400',
  blocked: 'bg-amber-500/15 text-amber-400',
  failed: 'bg-rose-500/15 text-rose-400',
};

export function RunResultCard({ result }: { result: RunResult }) {
  return (
    <div className="rounded-2xl border border-glass-edge bg-glass-l2 p-4">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${OUTCOME_TONE[result.outcome]}`}
      >
        {result.outcome}
      </span>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{result.summary}</p>
      {result.links?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {result.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-glass-edge px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- src/components/runs/RunResultCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the API client method**

In `src/lib/api/workflowsApi.ts`, alongside `getWorkflowRuns`:

```ts
listAllRuns: () => http<{ runs: WorkflowRun[] }>('/api/runs'),
```

Reuse whatever the file's existing fetch helper and `WorkflowRun` type are named — do not
introduce a second http helper.

- [ ] **Step 6: Write the failing page test**

`src/pages/RunsPage.test.tsx` — use `renderWithRouter` and `mockApi` from
`src/test-helpers.tsx` (see how `src/pages/WorkflowsPage.test.tsx` does it, if present):

```tsx
it('filters runs by kind when a chip is clicked', async () => {
  // mock listAllRuns → one doc-drift run, one reviewer run
  // render <RunsPage />
  // expect both rows visible
  // click the 'doc-drift' chip
  // expect only the doc-drift row visible
});
```

Fill in the mock wiring to match the existing test helpers; the assertions above are the contract.

- [ ] **Step 7: Run it and confirm it fails**

Run: `bun run test -- src/pages/RunsPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `RunsPage`**

`src/pages/RunsPage.tsx`. Requirements:

- Fetch via `workflowsApi.listAllRuns()`.
- Chip row of distinct `workflow_kind` values present in the results, plus an "All" chip. Selected
  chip is component state (not a route param).
- One row per run: kind, trigger badge, relative time via `timeAgo` from `@/lib/time`,
  `effective_status`.
- Row expands on click to render `<RunResultCard>` when
  `isRunResult(JSON.parse(run.result_json ?? 'null'))`. **Wrap the parse in try/catch** —
  `result_json` is untrusted TEXT and a malformed row must not blank the page.
- If the run has a `task_id` and its kind has a registered detail view, show a deep link to
  `/w/${kind}/${task_id}`.
- Empty state: "No runs yet."

- [ ] **Step 9: Add the route**

`src/App.tsx`, near the existing workflow routes at :127:

```tsx
<Route path="/runs" element={<RunsPage />} />
```

with a `lazy()` import matching the file's existing style.

- [ ] **Step 10: Run tests + typecheck**

Run: `bun run test -- src/pages/RunsPage.test.tsx src/components/runs && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/pages/RunsPage.tsx src/pages/RunsPage.test.tsx src/components/runs \
        src/lib/api/workflowsApi.ts src/App.tsx
git commit -m "feat(runs): add unified /runs feed with kind filter and result cards"
```

---

## Task A3: Nav consolidation and surface deletion

**Files:**

- Modify: `src/components/sidebar/nav-items.ts` (:20-30 primary, :32-50 more)
- Modify: `src/components/MobileBottomNav.tsx`, `src/App.tsx`
- Delete: `src/pages/WorkflowsPage.tsx`, `src/pages/ExtractsPage.tsx`,
  `src/workflows/doc-drift/register.tsx`, `src/workflows/pr-extract/register.tsx`,
  `src/workflows/prod-log-triage/register.tsx`
- Modify: `src/workflows/index.ts` (drop the three deleted side-effect imports)
- Test: `src/components/sidebar/nav-items.test.ts` if it exists

**Interfaces:**

- Consumes: `RunsPage` route from A2
- Produces: primary nav = Home, Tasks, Runs, Reviews, Settings; More = Monitor, Workspaces,
  Orchestrator, Schedules

- [ ] **Step 1: Confirm nothing references the doomed surfaces**

Run:

```bash
grep -rn "WorkflowsPage\|ExtractsPage\|/w/doc-drift\|/w/prod-log-triage\|/w/pr-extract" src e2e
```

Expected: only `src/App.tsx` and `src/workflows/index.ts`. **If anything else appears, stop and
report it** — the plan assumed these are unreferenced.

- [ ] **Step 2: Add Runs to primary nav**

`src/components/sidebar/nav-items.ts:20-30` — insert a Runs entry between Tasks and Reviews,
`to: '/runs'`. Reuse an existing glyph from `src/components/sidebar/glyphs`; do not add an icon
dependency.

- [ ] **Step 3: Delete the generated per-kind nav rows**

Remove the `listWorkflowUIs()` mapping at `nav-items.ts:42-50` and the now-unused import. Remove
the `Workflows` entry (`/workflows`) from the More list.

- [ ] **Step 4: Add Runs to mobile nav**

`src/components/MobileBottomNav.tsx:7-42` — the mobile bar currently holds four items. Replace
`Reviews` with `Runs` **only if** the bar cannot fit five without wrapping at 360px; otherwise add
Runs as a fifth. Check by rendering at 360px before deciding, and note which you chose in the
commit message.

- [ ] **Step 5: Delete the surfaces**

```bash
git rm src/pages/WorkflowsPage.tsx src/pages/ExtractsPage.tsx \
       src/workflows/doc-drift/register.tsx \
       src/workflows/pr-extract/register.tsx \
       src/workflows/prod-log-triage/register.tsx
```

Also delete any co-located `.test.tsx` for those files.

- [ ] **Step 6: Clean the client registry and routes**

- `src/workflows/index.ts:2-5` — leave only `import './loops/register';` (reviewer is not
  registered there; it lives at `/reviews`).
- `src/App.tsx:134` — delete the `/workflows` route and its lazy import.
- `src/App.tsx:131` — retarget the existing redirect: `/extracts` → `/runs?kind=pr-extract`.
- Delete the `WorkflowListRoute` import/route (`App.tsx:29`, and the `/w/:kind` route).
  **Keep** `WorkflowDetailRoute` and the `/w/:kind/:id` route — loops and reviewer still use it.

- [ ] **Step 7: Verify the app builds and nothing dangles**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS, no unused-import errors.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "refactor(nav): collapse per-workflow nav entries into unified /runs feed"
```

---

## Task A4: Tasks board shows manual work only

**Files:**

- Modify: `server/repositories/tasks.ts` (the board's list query)
- Modify: `src/components/TaskBoard.tsx` (toggle, mirroring the Trash pattern at :24, :213-218)
- Test: `server/repositories/tasks.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks
- Produces: `listTasks({ includeAutomated }: { includeAutomated?: boolean })` — automated tasks
  (`source IS NOT NULL`) hidden unless `includeAutomated` is true

- [ ] **Step 1: Locate the board's list query**

Run: `grep -n "export function listTasks" server/repositories/tasks.ts`

Read the function and its callers (`grep -rn "listTasks(" server src --include="*.ts"
--include="*.tsx"`). **Do not change `listNeedsYouTasks` (:854) or `listActivityTasks` (:880)** —
those are the inbox and already filter `auto_review`; they are out of scope.

- [ ] **Step 2: Write the failing test**

```ts
describe('listTasks automated filtering', () => {
  it('hides tasks with a non-null source by default', () => {
    createTask({ title: 'manual' }); // source defaults to null
    createTask({ title: 'drift', source: 'doc_drift' });

    const rows = listTasks();

    expect(rows.map((t) => t.title)).toEqual(['manual']);
  });

  it('includes automated tasks when asked', () => {
    createTask({ title: 'manual' });
    createTask({ title: 'drift', source: 'doc_drift' });

    expect(listTasks({ includeAutomated: true })).toHaveLength(2);
  });
});
```

Match the existing `createTask` helper signature in `server/test-helpers.ts`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test -- server/repositories/tasks.test.ts`
Expected: FAIL — both tasks returned in the first case.

- [ ] **Step 4: Implement**

Add an optional options arg to `listTasks` and append to its WHERE clause:

```ts
AND (? = 1 OR t.source IS NULL)
```

bound to `includeAutomated ? 1 : 0`. **Do not use string interpolation for the flag.** Keep the
default `includeAutomated = false`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun run test -- server/repositories/tasks.test.ts`
Expected: PASS.

- [ ] **Step 6: Thread the flag through the route**

`server/routes/tasks.ts` — the `GET /api/tasks` handler passes
`{ includeAutomated: req.query.includeAutomated === 'true' }`.

**Check every other `listTasks()` caller** found in Step 1. Any caller that needs all tasks
(reconciliation, pollers, CLI `list-tasks`) must pass `includeAutomated: true` explicitly.
Getting this wrong silently hides tasks from the CLI — enumerate the callers in your summary.

- [ ] **Step 7: Add the UI toggle**

`src/components/TaskBoard.tsx` — mirror the existing Trash toggle exactly (state at :24, control
at :213-218). Label: "Show automated". When on, refetch with `?includeAutomated=true`.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/repositories/tasks.ts server/repositories/tasks.test.ts \
        server/routes/tasks.ts src/components/TaskBoard.tsx
git commit -m "feat(tasks): hide automated tasks from the board behind a toggle"
```

---

# TRACK B — Result contract

## Task B1: Loop termination writes a run result

This is the highest-value task in the wave. It fixes doc-drift, prod-log-triage, and loops at once,
because all three terminate through the same choke point.

**Files:**

- Modify: `server/task-engine/loop/engine.ts` (single termination site at :261)
- Test: `server/task-engine/loop/engine.test.ts`

**Interfaces:**

- Consumes: `finishRun(id, { status, result })` from `server/repositories/runs.js` (unchanged);
  `RunResult` from `@octomux/types`; the existing `TerminationReason` union at `engine.ts:29`
- Produces: on loop termination, the run row reaches a terminal status with a `RunResult` envelope

- [ ] **Step 1: Read the termination path**

Read `server/task-engine/loop/engine.ts` lines 100-130 (the pure `terminationReason` policy) and
250-290 (the site that persists `terminationReason` and logs at :268). The `reason` value is in
scope at :261 — that is where the run must be finished.

- [ ] **Step 2: Establish how the loop reaches its `runs` row**

Run: `grep -rn "insertRun\|loopRunId\|loop_run_id" server/task-engine/loop server/services/doc-drift-service.ts server/services/prod-log-triage-service.ts`

`doc-drift-service.ts:59` and `prod-log-triage-service.ts:61` call `insertRun({ taskId })` and
discard the returned row. The loop engine has no reference to the run id.

**Fix:** thread it. Pass the `runs.id` into `startLoop`'s spec, persist it on the `loop_runs` row,
and pass `loopRunId` to `insertRun` so the linkage is bidirectional (this also makes
`runs.loop_run_id` non-dead for the first time). If `loop_runs` has no column for it, store it in
the existing `spec_json` blob rather than adding a migration.

- [ ] **Step 3: Write the failing test**

```ts
it.each([
  ['done', 'done'],
  ['blocked', 'blocked'],
  ['max_iterations', 'failed'],
  ['budget', 'failed'],
  ['no_progress', 'failed'],
  ['needs_human', 'blocked'],
] as const)('termination reason %s finishes the run as %s', (reason, expectedOutcome) => {
  // arrange a loop run whose termination policy yields `reason`
  // act: drive the engine to termination
  const run = getRun(runId);
  expect(run?.status).not.toBe('running');
  expect(run?.ended_at).not.toBeNull();
  const result = JSON.parse(run!.result_json!);
  expect(result.outcome).toBe(expectedOutcome);
  expect(typeof result.summary).toBe('string');
});
```

Follow the existing arrange helpers in `engine.test.ts`. **Every reason must be covered** — the
whole point is that non-happy-path terminations stop leaving rows stuck at `running`.

- [ ] **Step 4: Run it and confirm it fails**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: FAIL — runs stay `running`, `result_json` null.

- [ ] **Step 5: Implement**

At the termination site (`engine.ts:261`), alongside the existing `terminationReason` persistence:

```ts
const OUTCOME_FOR_REASON: Record<TerminationReason, RunResult['outcome']> = {
  done: 'done',
  blocked: 'blocked',
  needs_human: 'blocked',
  max_iterations: 'failed',
  budget: 'failed',
  no_progress: 'failed',
};

if (runId) {
  const outcome = OUTCOME_FOR_REASON[reason];
  finishRun(runId, {
    status: outcome,
    result: {
      outcome,
      summary: emitReason ?? `Loop stopped: ${reason} after ${iterationN} iteration(s).`,
      links: prUrl ? [{ label: 'Pull request', url: prUrl }] : undefined,
    } satisfies RunResult,
  });
}
```

Use the agent's emitted `reason` text when present (that is the agent-authored summary the spec
calls for); fall back to the mechanical string only for non-emit terminations. Source `prUrl` from
the task row if it has one — do not shell out to `gh` here.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: PASS, all six reasons.

- [ ] **Step 7: Full suite + typecheck**

Run: `bun run typecheck && bun run test`

- [ ] **Step 8: Commit**

```bash
git add server/task-engine/loop server/services/doc-drift-service.ts \
        server/services/prod-log-triage-service.ts
git commit -m "fix(loop): finish the run row on every termination reason"
```

---

## Task B2: `daily-plan` finishes its run

**Files:**

- Modify: `server/services/daily-plan-service.ts` (26 lines — read it whole first)
- Test: `server/services/daily-plan-service.test.ts`

**Interfaces:**

- Consumes: `finishRun`; `RunResult`
- Produces: daily-plan runs reach a terminal status instead of `running` forever

- [ ] **Step 1: Find the chat-close signal**

Run: `grep -rn "closeChat\|chat.*status\|archived" server/chats.ts server/routes/chats.ts | head -20`

daily-plan is chat-backed with no `task_id`, so the `COALESCE` rescue in `runs.ts:86` cannot help
it — it needs an explicit finish. Identify where a chat reaches a terminal state.

- [ ] **Step 2: Write the failing test**

```ts
it('finishes the daily-plan run when its chat closes', () => {
  const { runId, chatId } = startDailyPlanForTest();
  closeChat(chatId);

  const run = getRun(runId);
  expect(run?.status).toBe('done');
  expect(JSON.parse(run!.result_json!).outcome).toBe('done');
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun run test -- server/services/daily-plan-service.test.ts`
Expected: FAIL — status still `running`.

- [ ] **Step 4: Implement**

On chat close, look up the run by `chat_id` and `finishRun` with:

```ts
{ outcome: 'done', summary: 'Daily planning session completed.',
  links: [{ label: 'Chat', url: `/chats/${chatId}` }] }
```

If no run row references the chat, do nothing — this must not throw for ordinary chats.

- [ ] **Step 5: Run the test, then full suite**

Run: `bun run test -- server/services/daily-plan-service.test.ts && bun run typecheck`

- [ ] **Step 6: Commit**

```bash
git add server/services/daily-plan-service.ts server/services/daily-plan-service.test.ts
git commit -m "fix(daily-plan): finish the run when the planning chat closes"
```

---

## Task B3: Envelope in the two session-vertical output schemas

**Files:**

- Modify: `server/workflows/overnight-log-summary/schema.ts`,
  `server/workflows/weekly-update/schema.ts`
- Modify: `skills/overnight-log-summary/SKILL.md`, `skills/weekly-update/SKILL.md`
- Test: `server/workflows/overnight-log-summary/schema.test.ts` (create if absent)

**Interfaces:**

- Consumes: `RUN_RESULT_SCHEMA` from `@octomux/types`
- Produces: both schemas require `outcome` + `summary` alongside their existing fields

These two kinds already reach `finishRun` correctly. This task only widens their schema so their
results render in the same card as everything else.

- [ ] **Step 1: Write the failing schema test**

```ts
it('requires the run-result envelope alongside kind-specific fields', () => {
  const validate = new Ajv().compile(OVERNIGHT_LOG_SUMMARY_SCHEMA);

  expect(validate({ window: '8h', summary: 'ok', errorClasses: [], notableEvents: [] })).toBe(
    false,
  );
  expect(
    validate({
      outcome: 'done',
      summary: 'ok',
      window: '8h',
      errorClasses: [],
      notableEvents: [],
    }),
  ).toBe(true);
});
```

Note: `summary` already exists in the overnight schema and means the same thing — **reuse it, do
not add a second summary field.**

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- server/workflows/overnight-log-summary`

- [ ] **Step 3: Merge the envelope into both schemas**

Add `outcome` (and `links`) to `properties`, and add `outcome` to `required`. Keep each schema's
existing fields untouched.

- [ ] **Step 4: Update both SKILL.md files**

The agent must know to emit `outcome`. Add one line to the `submit_result` instructions in each
skill describing `outcome` and `links`. Edit **`skills/`**, not `.claude/skills/`.

- [ ] **Step 5: Run tests + typecheck, then commit**

```bash
git add server/workflows/overnight-log-summary server/workflows/weekly-update skills
git commit -m "feat(workflows): require the run-result envelope in session-vertical outputs"
```

---

## Task B4: `pr-extract` emit finishes its run

**Files:**

- Modify: `server/routes/pr-extracts.ts` (:21 emit handler)
- Test: `server/routes/pr-extracts.test.ts`

**Interfaces:**

- Consumes: `finishRun`; existing `PR_EXTRACT_OUTPUT_SCHEMA` validation (unchanged)
- Produces: emitting a pr-extract finishes the run row; the `pr_extracts` table is unchanged

- [ ] **Step 1: Write the failing test**

```ts
it('finishes the run row when an extract is emitted', async () => {
  const { taskId, runId } = seedPrExtractRun();

  await request(createApp())
    .post(`/api/pr-extracts/${taskId}/emit`)
    .set('x-hook-token', token)
    .send({ area: 'server', risk: 'low', has_migration: false, surface: 'api', loc: 42 })
    .expect(200);

  expect(getRun(runId)?.status).toBe('done');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- server/routes/pr-extracts.test.ts`

- [ ] **Step 3: Implement**

After the existing `pr_extracts` insert, look up the run by `task_id` + `workflow_kind =
'pr-extract'` and finish it:

```ts
{ outcome: 'done', summary: `Extracted: ${area} · risk ${risk} · ${loc} LOC`,
  links: prUrl ? [{ label: `PR #${prNumber}`, url: prUrl }] : undefined }
```

**Keep the `pr_extracts` row as the source of truth** — this is an addition, not a migration.
If no run row exists, skip silently.

- [ ] **Step 4: Run tests + typecheck, then commit**

```bash
git add server/routes/pr-extracts.ts server/routes/pr-extracts.test.ts
git commit -m "feat(pr-extract): finish the run row on emit"
```

---

## Self-review notes

**Spec coverage.** §5 shapes A–D map to B3 (A), B1 (B), B4 + B1 (C), B2 (D). §4.1/4.2 → A2 + A3.
§4.3 → A4. §9 deletions → A3. **Not in this wave, by design:** §3 single descriptor, §3.1 folder
moves, §6 config form — these are P3–P5 and collide with every file Track B touches.

**Known gap.** The `reviewer` kind already inserts a run (`review-service.ts:91`) and is not
finished by this wave. It is the largest service with three external consumers, and its publish
path is human-gated, so its terminal moment is ambiguous. Deferred to Wave 2 deliberately — noted
so it is not mistaken for an oversight.

**Type consistency.** `RunResult`, `RUN_RESULT_SCHEMA`, `isRunResult` are defined once in
`packages/types` (Task 0) and used unchanged by A2, B1, B2, B3, B4.
