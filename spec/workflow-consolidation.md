# Workflow Consolidation — one descriptor, one folder, one feed

Status: draft (design)
Date: 2026-07-20
Supersedes: `spec/workflow-framework.md` §4 (registry mechanism) and the P3 row of §9.
Related: `spec/workflow-framework.md` (the framework this corrects), `spec/harness-abstraction.md`
(the registry pattern this mirrors)

> **Context.** P3 of the workflow framework shipped: the `WorkflowType` registry, the
> `/w/:kind` generic routes, and the client `registerWorkflowUI` component registry all exist
> and work. But the registry made "a workflow gets a nav entry" a one-line change, so every
> kind took one — including two whose entire list view is a client-side `.filter()` over
> `GET /api/tasks`. This spec keeps the framework and fixes the surface it grew.

## 1. Problem

Three distinct problems, one root cause: **the registry rewards adding surface area.**

### 1.1 Nav sprawl

The sidebar "More" section holds 9 entries (`src/components/sidebar/nav-items.ts:32-50`):
Monitor, Workspaces, Orchestrator, Schedules, Workflows, plus one auto-generated entry per
registered workflow UI (doc-drift, loops, pr-extract, prod-log-triage). Kind 9 costs another row.

Two of those four "pages" are not pages. `src/workflows/doc-drift/register.tsx:11` and
`src/workflows/prod-log-triage/register.tsx:11` are the same 50 lines of hand-rolled list markup
whose only logic is:

```ts
taskApi.listTasks().then((all) => setTasks(all.filter((t) => t.source === 'doc_drift')));
```

That is a saved filter that got promoted to a nav item because the registry made it cheap.

There is also a second, competing nav axis. `Tasks` is a board sliced by **workflow status**;
`/w/doc-drift` is the same task rows sliced by **source**. Same objects, two hierarchies.

### 1.2 No run result

`runs.result_json` (`server/db/schema.ts:190`) is populated by exactly one code path —
`finishRun` at `server/agent-session/session.ts:344`, reached only by the headless
`runSessionVertical` shape. Consequences, all live today:

- `doc-drift` and `prod-log-triage` insert a `runs` row and **never finish it**. Those rows
  read `status='running'`, `ended_at=NULL`, forever.
- `daily-plan` is worse: it is chat-backed with no `task_id`, so the `COALESCE(t.runtime_state,
runs.status)` rescue in `LIST_WITH_EFFECTIVE_STATUS_SQL` (`server/repositories/runs.ts:86`)
  has nothing to join against. It displays as `running` permanently.
- `loops` never inserts a `runs` row at all, so its run count on `/workflows` is always 0.
- `runs.loop_run_id` is accepted by `InsertRunInput` (`runs.ts:33`) but **never written by any
  caller**, making the loop deep-link button at `src/pages/WorkflowsPage.tsx:124-133` dead code.

So "what happened in last night's run?" has no answer in the product. This is upstream of any
visual design: `SessionRunResult` (`WorkflowsPage.tsx:56`) is the only result renderer and its
`formatResultField` (`:32`) flattens nested objects to `[object Object]`. There is no result
model to render, so there is nothing to style.

### 1.3 A workflow is scattered across two directories and two registries

Adding a kind today touches six places, and the code for one kind lives in two trees:

| #   | File                                                               | Role                                   |
| --- | ------------------------------------------------------------------ | -------------------------------------- |
| 1   | `server/workflows/<kind>/register.ts`                              | descriptor + `registerScheduleHandler` |
| 2   | `server/workflows/index.ts:1-9`                                    | side-effect import (hand-maintained)   |
| 3   | `server/workflows/<kind>/schema.ts`                                | output schema (optional)               |
| 4   | `server/services/<kind>-service.ts`                                | what the run actually does             |
| 5   | `skills/<kind>/SKILL.md`                                           | the agent prompt                       |
| 6   | `src/workflows/<kind>/register.tsx` + `src/workflows/index.ts:2-5` | a React file per kind                  |

The split is not load-bearing. Five of six workflow services have **exactly one consumer —
their own `register.ts`**:

```
doc-drift-service             → workflows/doc-drift/register.ts           only
prod-log-triage-service       → workflows/prod-log-triage/register.ts     only
daily-plan-service            → workflows/daily-plan/register.ts          only
overnight-log-summary-service → workflows/overnight-log-summary/register  only
weekly-update-service         → workflows/weekly-update/register.ts       only
pr-extract-service            → poller/merged-pr.ts                       ← external
review-service                → poller/reviewer-requests.ts, routes/reviews.ts, routes/review-runs.ts
```

And there are **two registries keyed by the same string**, populated adjacently in every single
`register.ts`: the workflow registry (`server/workflows/registry.ts:3`) and the schedule-handler
map (`server/schedules/handlers.ts:10`).

### 1.4 Instance config is undiscoverable

Per-kind knobs are read as bare `cfg.x ?? DEFAULT` inside each handler — `verify` and
`maxIterations` for doc-drift (`server/workflows/doc-drift/register.ts:33-34`), `logCommand` for
overnight-log-summary (`register.ts:40`). Nothing declares them. No schema, no form, no
validation. Learning that doc-drift accepts `maxIterations` requires reading the handler source.

The descriptor already carries an `output: JsonSchema` field. The mechanism for fixing this is
sitting next to the hole.

## 2. Goals / non-goals

**Goals**

1. Nav stops growing with kind count.
2. Every run finishes with a result a human can read.
3. One kind = one folder = one descriptor.
4. Instance config is declared, validated, and rendered as a form.

**Non-goals (YAGNI)**

- **Board graduation.** Not promoting a run-created task onto the Tasks board when it opens a PR
  or emits `needs_human`. The run card carries the PR link; Runs is where automated work is
  checked. Add only if PRs are actually missed in practice (§7).
- **Migrating `pr_extracts` / `loop_iterations` into `runs.result_json`.** Those tables work and
  have real queries over them. They gain a `finishRun` call, not a rewrite.
- **Unifying the two AJV instances** (`submit-result-server.ts:72` compiles per-call;
  `services/output-contract.ts:13` caches by key). Cosmetic; leave it.
- **Auto-discovering workflow folders by glob.** Breaks the tsup server bundle. The
  hand-written import list in `server/workflows/index.ts` stays — one line per kind is the
  correct price for a build-safe bundle.
- **Co-locating client and server workflow code in one folder.** `server/` and `src/` are
  different build targets (tsup vs vite); merging them drags React into the server bundle.

## 3. The single interface

One descriptor per kind, absorbing the schedule handler and gaining a config schema:

```ts
export interface WorkflowType {
  kind: string;
  displayName: string;
  surfaces: Surface[]; // 'session' | 'artifact' | 'feed'
  trigger?: { kind: 'cron' | 'github' | 'manual'; event?: string };

  config?: JsonSchema; // NEW — renders the /schedules form, validates config_json
  output?: JsonSchema; // validated by submit_result → runs.result_json

  run?: (ctx: RunContext) => Promise<void>; // NEW — absorbs registerScheduleHandler
  apiRouter?: Router; // pr-extract, reviewer only
}

interface RunContext {
  repoPath: string;
  config: unknown; // already validated against `config`
  scheduleId?: string; // present for cron triggers
  event?: unknown; // present for github triggers
}
```

**`server/schedules/handlers.ts` deletes entirely.** The cron poller resolves
`getWorkflow(kind).run` instead of a second map. `listScheduleKinds()` becomes
`listWorkflows().filter((w) => w.trigger?.kind === 'cron').map((w) => w.kind)`.

This generalizes past cron. `server/poller/merged-pr.ts` and `server/poller/reviewer-requests.ts`
are the same dispatcher shape for github triggers — both become generic lookups over the one
registry rather than importing services directly. All three pollers converge on
`getWorkflow(kind).run(ctx)`.

### 3.1 Folder layout

```
server/workflows/<kind>/
  index.ts     the descriptor — the whole interface, one screen
  schema.ts    config + output JSON schemas
  run.ts       was server/services/<kind>-service.ts
  routes.ts    apiRouter — only pr-extract and reviewer
```

**Moves in:** `doc-drift-service`, `prod-log-triage-service`, `daily-plan-service`,
`overnight-log-summary-service`, `weekly-update-service` (single consumer each — pure moves);
`pr-extract-service` and `review-service` (their external consumers become registry lookups, and
`routes/reviews.ts` + `routes/review-runs.ts` move to `workflows/reviewer/routes.ts` behind
`apiRouter`).

**Stays in `server/services/`:** `session-vertical-service.ts` — shared infrastructure, imported
by both overnight-log-summary and weekly-update. It is the Shape A runner, not a kind.

**Stays put:** `skills/<kind>/SKILL.md`. It is dual-purpose — shipped in the npm `files` list and
loaded at runtime by `getSkill()`, while `.claude/skills/` must stay where Claude Code finds it.
See §7 for the divergence issue this leaves open.

### 3.2 Client registry shrinks

`src/workflows/` survives but contributes **only a detail renderer**, never a nav entry.
`nav-items.ts:42-50` (the generated per-kind rows) deletes.

Registered detail views drop from 4 kinds to 2 — **reviewer** and **loops** — because their
artifacts are genuinely novel: a diff with inline comment threads, and an iteration ledger with
per-`n` verify/emit state. Everything else renders from its `output` schema via the existing
`DefaultDetailView`. This also kills the `if (kind === 'reviewer') return '/reviews'` special
case at `WorkflowsPage.tsx:26`.

## 4. Surfaces

### 4.1 Nav

```
Primary:  Home · Tasks · Runs · Reviews · Settings
More:     Monitor · Workspaces · Orchestrator · Schedules
```

**Deleted:** `/workflows`, `/w/doc-drift`, `/w/prod-log-triage`, `/w/pr-extract`, `ExtractsPage`,
and the generated per-kind nav rows.

**Kept:** `/w/:kind/:id` for detail. The generic detail route stays; only the generic _list_
routes go.

### 4.2 Runs — the one feed

`/runs` lists every invocation, newest first, filtered by a kind chip row. A row shows kind,
trigger, repo, relative time, and outcome. Expanding a row renders the result card (§5). Rows
deep-link to `/w/:kind/:id` when the kind has a detail view.

This replaces four list pages plus `/workflows` with one page and a filter.

### 4.3 Tasks — manual work only

The board filters to manual tasks by default. The rule already exists in the codebase, hardcoded
to one kind — `server/repositories/tasks.ts:860` and `:886`:

```sql
AND (t.source IS NULL OR t.source <> 'auto_review')
```

Generalize it to `t.source IS NULL`. Manual creates leave `source` NULL
(`tasks.ts:369` — `input.source ?? null`, no column default); every automated path sets it. So
this needs **no enum, no mapping table, no registry lookup**, and hides every future workflow
kind automatically on the day it is added.

Escape hatch: a "Show automated" toggle reusing the pattern already in `TaskBoard.tsx:24` /
`:213-218` (how the Trash column is hidden). No new mechanism.

## 5. The result contract

Every workflow finishes its run. One universal envelope, on top of whatever kind-specific
`output` schema the kind already declares:

```ts
{
  outcome: 'done' | 'blocked' | 'failed',
  summary: string,                          // agent-authored: what happened, in prose
  links?: { label: string, url: string }[]  // PR, incident file, dashboard
}
```

`summary` is written by the agent at the end of its run, where it already has the full context.
`submit_result` already validates args and returns `isError: true` on mismatch so the model
retries (`server/agent-session/mcp/submit-result-server.ts:66-86`) — the retry loop is free.

Mapping by shape:

| Shape                 | Kinds                                | Change                                                                                                                                                   |
| --------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — headless session  | overnight-log-summary, weekly-update | already works; envelope added to schema                                                                                                                  |
| B — task + retry loop | doc-drift, prod-log-triage           | **new**: emit envelope at loop end, call `finishRun`. doc-drift's link is the PR; prod-log-triage's is the incident file + PR                            |
| C — task + HTTP emit  | pr-extract, loops, reviewer          | keep the dedicated tables; the emit endpoints **also** call `finishRun` instead of being a parallel universe. Fixes `loops` never inserting a `runs` row |
| D — interactive chat  | daily-plan                           | emit envelope on chat close; link to the chat                                                                                                            |

Side effects of this section: the permanent-`running` bug is fixed, `runs.loop_run_id` gets
written (making `WorkflowsPage`'s dead deep-link live before it moves to `/runs`), and there is
finally a consistent object worth designing a card for.

## 6. Config schema → generated form

Add `config?: JsonSchema` to the descriptor. `/schedules` renders a form from it, exactly as
`IntegrationProvider.configSchema` already does for Jira and Linear — same pattern, same
validation, no new concept.

Declared config per kind at migration time:

```
doc-drift             { verify: string, maxIterations: number }
prod-log-triage       { verify: string, maxIterations: number }
overnight-log-summary { logCommand: string }
```

Defaults move from inline `?? DEFAULT` expressions into the schema's `default` keyword, so they
are visible in the form.

Validation happens once, at schedule save and before `run()`. `RunContext.config` is
post-validation, so `run.ts` drops its `JSON.parse(row.config_json ?? '{}')` +
`cfg.x ?? DEFAULT` preamble entirely.

**Open:** `schedules` has `UNIQUE(kind, repo_path)` (`server/db/schema.ts:168`), so one config
per kind per repo — no "doc-drift hourly on `src`, daily on `docs`". Relaxing it is a
forward-only migration and is **out of scope here**; noted because the config form makes the
limit visible for the first time.

## 7. Risks & open questions

- **Hidden automated tasks hide their PRs.** doc-drift and prod-log-triage exist to open a PR;
  filtered off the board, that PR never appears in the PR column. Mitigated by the run card's
  `links`, but only if Runs is actually checked. If PRs get missed, add board graduation on
  `needs_human` / PR-opened (§2 non-goal) — the `needs_human` vocabulary already exists in the
  loop emit endpoint.
- **`finishRun` for Shape B needs a loop-end hook.** The retry loop currently terminates on the
  `verify` string with no completion callback. Wiring the envelope means the loop engine must
  emit on termination for every termination reason, including `maxIterations` exhausted and
  budget exhausted — not just the happy path. Failing to cover those reintroduces stuck
  `running` rows for exactly the runs most worth seeing.
- **Skill divergence.** `skills/weekly-update/SKILL.md` and `.claude/skills/weekly-update/SKILL.md`
  have drifted. Out of scope, but touching every workflow folder is when someone will notice —
  decide whether `.claude/skills/` should symlink to `skills/` or the dev superset is intentional.
- **`review-service.ts` is 238 lines with three external consumers.** The largest move in §3.1
  and the only one that is not mechanical. Sequence it last, after the pattern is proven on the
  five single-consumer services.
- **Result card fidelity.** `formatResultField` renders arrays of objects as flattened
  `key: value` strings and top-level nested objects as `[object Object]`. The envelope is flat
  enough to dodge this, but kind-specific `output` (e.g. overnight-log-summary's
  `errorClasses[{name,count,severity}]`) still needs a real renderer. Define the schema → widget
  mapping, which `spec/workflow-framework.md` §8 already flags as open.

## 8. Phasing

Ordered so each phase ships independently and the riskiest move comes last.

1. **P1 — Result contract.** Envelope in the shared output schema; `finishRun` wired for Shapes
   B, C, D; loop-end emit covering all termination reasons. Fixes the permanent-`running` bug.
   No UI change. _This is the phase that answers "what happened last night" and is worth
   shipping alone._
2. **P2 — Runs feed + nav.** Build `/runs`; delete `/workflows`, the three generic list routes,
   `ExtractsPage`, and the generated nav rows. Board filter to `source IS NULL` + "Show
   automated" toggle.
3. **P3 — Single descriptor.** Add `run()` and `config` to `WorkflowType`; delete
   `server/schedules/handlers.ts`; converge the three pollers on `getWorkflow(kind).run`.
4. **P4 — Folder moves.** Five single-consumer services first (mechanical), then `pr-extract`,
   then `reviewer` + its routes.
5. **P5 — Config form.** Render `/schedules` from `config` schemas; move defaults into the
   schemas.

P1 and P2 are independently valuable. P3–P5 are the consolidation and can slip without blocking
the surface fix.

## 9. Migration notes

- **No DB migration required.** `runs.result_json` already exists; the envelope is a convention
  inside an existing TEXT column. The `UNIQUE(kind, repo_path)` relaxation (§6) is deferred.
- **Deletions** (P2): `src/pages/WorkflowsPage.tsx`, `src/pages/ExtractsPage.tsx`,
  `src/workflows/doc-drift/register.tsx`, `src/workflows/pr-extract/register.tsx`,
  `src/workflows/prod-log-triage/register.tsx`, `nav-items.ts:42-50`.
  (P3): `server/schedules/handlers.ts`.
- **Route removals.** `src/App.tsx:131` already redirects `/extracts → /w/pr-extract`; retarget
  it to `/runs?kind=pr-extract` rather than deleting, since it exists precisely because that URL
  was bookmarked once. The `/w/:kind` list routes are recent enough that a 404 is acceptable.
  `/reviews` is unchanged.
- **No E2E coverage to update.** Grepping `e2e/` for `doc-drift-row-*`, `/w/doc-drift`,
  `/w/prod-log-triage`, `/w/pr-extract`, and `/workflows` returns nothing — none of the deleted
  surfaces are exercised by Playwright. Deleting them breaks no test, which is itself a signal
  about how load-bearing they are.
- **`DefaultDetailView` already handles the fallback.** `src/workflows/WorkflowDetailRoute.tsx`
  falls back to it when a kind registers no `DetailView`, covered by a test at
  `src/workflows/WorkflowDetailRoute.test.tsx:28`. §3.2 needs no new machinery — just fewer
  registrations.
