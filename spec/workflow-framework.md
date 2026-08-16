# Workflow Framework — autonomous agent loops & auto-triggered workflows as pluggable verticals

Status: draft (design)
Date: 2026-07-12
Related: `spec/harness-abstraction.md`, `server/integrations/types.ts` (IntegrationProvider),
`server/poller.ts` (GitHub review trigger), `cli/review/*` (agent write-back),
`server/task-runner.ts` / `server/chats.ts` (agent lifecycle — the loop harness)

> **Priority:** the **Loop primitive** (§3.3) is the P1 reference build. octomux already owns the
> agent lifecycle + worktree/tmux isolation + dashboard — the hard layers of a loop harness — so
> "loop engineering" is the most differentiated capability the framework can ship first. The
> trigger→output→sink workflows (reviews, PR-extract) ride on the same primitives and follow.

## 1. Problem

Today, an auto-triggered agent feature — the canonical example being **PR reviews** — is a
hand-built full-stack vertical. Tracing reviews end to end:

| Layer        | Review's implementation                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trigger      | `poller.ts` polls GitHub `review-requested:@me` → `insertReviewTask()` creates a task running `/review-orchestrator`                                                                                                                             |
| Agent work   | skills `/review-orchestrator` → `/review-walkthrough` → `/review-deep` inside the task's worktree/tmux                                                                                                                                           |
| Write-back   | agent calls `cli/review/*` (`start`, `walkthrough`, `draft-comment`, `complete`) — these import server modules and **mutate SQLite in-process** (e.g. `cli/review/complete.ts` calls `completeRun`/`broadcast` directly), _not_ an HTTP endpoint |
| Result store | dedicated tables/modules: `review-runs.ts`, `walkthrough.ts`, `inline-comments.ts`, `file-review-state.ts`, `published-reviews.ts`                                                                                                               |
| API          | bespoke `/api/reviews`, `/api/review/*` handlers in `api.ts`                                                                                                                                                                                     |
| Custom UI    | explicit `<Route>` entries in `App.tsx` → `ReviewsPage.tsx` / `ReviewDetailPage.tsx` → `components/review/*`, fed by `useReviewQueue.ts`                                                                                                         |

Nothing about this is reusable by a second workflow. Adding "auto-triage incoming issues"
or "extract PR risk into a table" means copying the entire stack: new poller branch, new
tables, new API namespace, new pages, new routes in `App.tsx`.

Some raw materials exist in embryo — but the load-bearing seams are **green-field**, and this spec
is explicit about which is which (a prior review found earlier drafts overstated readiness):

- **A plugin registry** — `IntegrationProvider` + `registerProvider()` (`server/integrations/`),
  with a `configSchema` JSON Schema meant to render a UI form. Jira and Linear register through it.
  _Genuinely reusable as the registry pattern._
- **An outbound event dispatcher** (not a subscribable bus) — `hook-dispatcher.ts`'s `fireHook()`
  fan-outs a **closed 7-value enum** (`hook-types.ts`) to shell hooks + integration providers,
  fire-and-forget. There is **no in-process pub/sub the loop engine can `await`** ("agent stopped");
  today the only end-of-turn signal is the Claude Stop hook HTTP route (`server/hooks.ts`). Adding
  Triggers means extending that enum and building a real subscription seam — net-new.
- **A pluggable harness layer** — Claude Code / Cursor behind a common interface. _Reusable._
- **A standalone-agent primitive** — "chats" (`server/chats.ts`): a runtime agent with
  `task_id=NULL`, its own tmux session, rendered as a live `TerminalView`. _Reusable for `session`._
- **NOT yet present — a `TaskRunner` port.** `task-runner.ts` functions take DB rows and directly
  mutate `getDb()`, shell out to tmux, and `broadcast()` inline; there is no spawn→await-stop→exit
  API and no "respawn agent in place" primitive. The injected-adapter boundary (§6) must be _built_,
  not merely wired. See §3.3 for the loop-specific constraints this imposes.

**Goal:** factor the repeated skeleton into a **workflow framework** so a new auto-triggered
workflow is a declaration + optional custom UI, not a copied vertical. Reviews and the
orchestrator chat become the two reference implementations, proving the abstraction against
both a rich artifact flow and a live session flow.

## 2. Prior art & differentiation

- **[GitHub Agentic Workflows (`gh-aw`)](https://github.github.io/gh-aw/)** — markdown workflows
  triggered by GitHub events; the agent emits a **structured artifact** of intended actions, and a
  separate _gated_ job with scoped permissions applies only whitelisted operations. This is exactly
  the **trigger → output contract → gated sink** pattern — but it lives inside GitHub Actions: no
  self-hosted dashboard, no rich result UI, no live session surface, no worktree fleet.
- **[n8n](https://n8n.io/ai-agents/)** — trigger → agent → Structured Output Parser → SQL/other
  sinks. Validates the primitive decomposition, but is general automation, not coding-agent-native
  (no git isolation, no review-grade UI, single-shot agent nodes).
- **Loop engineering / Ralph loop** — Geoffrey Huntley's [Ralph loop](https://ghuntley.com/ralph/)
  (run a coding agent in a `while` loop, feeding the same spec against a fresh context until success
  criteria are met) crystallized in 2026 into "loop engineering" (popularized by Boris Cherny). The
  field's consensus [5-layer model](https://claudeskills.info/loop-engineering/) — harness, state
  layer, loop contract, checker, human checkpoint — maps almost 1:1 onto this framework's primitives
  (§3.3). The official `ralph-loop` Claude Code plugin implements this with a **Stop hook** inside a
  _single_ session that re-injects the prompt — so context accumulates rather than resetting, it is
  one session (no fleet), and termination is a brittle `<promise>DONE</promise>` string match with a
  max-iteration cap. octomux controls the agent _process_, so it can do true fresh-context Ralph
  (kill + respawn in the same worktree) with observable, layered termination — the wedge for §3.3.
- **Orchestration libraries** — Microsoft Agent Framework, LlamaIndex Workflows, Claude Code
  dynamic workflows — operate _within_ a single run. They are a layer below this framework (they
  are candidate implementations of the **Run** primitive).
- **Claude Code multiplexers with dashboards** — octomux's own category has competitors; none
  described expose a declared output-contract → sink → auto-UI layer.

**Wedge:** nobody combines (1) a self-hosted Claude Code fleet with worktree/tmux isolation,
(2) native agent-lifecycle control usable as a **loop harness** with observable, layered
termination, (3) a declarative trigger → output-contract → pluggable-sink framework, and (4) rich
custom _and_ live-session UI surfaces. `gh-aw` proves the automation half but is UI-less and
CI-bound; n8n proves the primitives but isn't agent-native; the `ralph-loop` plugin proves loops
but is single-session, context-accumulating, and unobservable.

## 3. Core abstractions

> **Scope discipline (ponytail pass):** P1 is a **loop harness**, and a loop harness needs no
> Trigger, no Sink, no Gate, no schema-validation framework, no surface taxonomy, no registry, and no
> package. Those are the _eventual_ framework shape and are catalogued in §11 (Deferred framework
> primitives) — **not built until a workflow needs them.** This section specs only what the loop
> actually uses: the **Run** primitive in `loop` mode plus the Loop Contract (§3.3) and a fixed
> completion callback (§3.1).

The one primitive P1 touches:

| Primitive | Responsibility (P1 slice)                                                                                                                           | Exists today                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Run**   | how the agent executes: harness + agent + prompt/skill + worktree isolation; **`mode: 'once' \| 'loop'`** — loop mode adds the Loop Contract (§3.3) | `task-runner.ts`, `chats.ts` |

Everything else (Trigger, Filter, Output Contract as a schema framework, Sink, Gate, Surface
taxonomy) is deferred — see §11.

### 3.1 The loop completion callback (P1 keystone — must be nailed)

The loop's only agent→server signal. It is a **fixed-shape POST**, _not_ the general schema-validated
Output Contract (that arrives with the `sql` sink in P2 — §11):

- **Transport.** HTTP POST to `hookBaseUrl()` (`http://127.0.0.1:<port>`), matching how harness hooks
  already call back — _not_ the in-process SQLite path `cli/review/*` uses.
- **Auth.** Reuse the existing per-agent `hook_token` (`server/hooks.ts`); the agent's launch env
  already carries it. No new secret.
- **Run-id injection.** The `--run <id>` is pinned into the agent's prompt at spawn (the pattern
  reviews already use — `poller.ts` bakes the review-task id into `buildReviewPrompt`).
- **Payload.** Fixed enum: `{ status: 'done' | 'blocked' | 'needs_human', reason: string }`.
  Hand-validated (three-field check) — **no `ajv`/JSON-Schema engine in P1.** `done` requires the
  verifier to also pass (agent self-report is necessary, not sufficient — §3.3 verifier-trust risk).

### 3.2 UI surfaces (P1 uses two; taxonomy stays informal)

P1's loop UI reuses two existing shapes — a **feed** (list of loops) and an **artifact** detail (the
Iteration Ledger) — plus the existing **session** terminal for "drop into the live agent." That's
description, not a framework: no surface _registry_ or archetype abstraction is built in P1. The
`session`/`artifact`/`feed` naming becomes a real registered contract only in P3, when reviews and
chat need it (§11). See §10 for the concrete P1 components.

### 3.3 Loop primitive & Loop Contract — the P1 reference build

"Loop engineering" is the discipline of designing the system that repeatedly prompts, verifies,
retries, and stops an agent — instead of a human prompting turn by turn. It is **not a separate
system**; it is the **Run** primitive in `mode: 'loop'` plus a declared **Loop Contract**. octomux
is a near-ideal harness because it already owns the two hardest layers.

**Field 5-layer model ↔ octomux:**

| Loop-engineering layer            | Need                                                              | octomux                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness (environment)             | isolated, reproducible workspace per run                          | ✅ worktree + tmux + agent (`task-runner.ts`)                                                                                                                                                             |
| State layer (survives restarts)   | files/git _and_ controller bookkeeping persisting across restarts | ⚠️ worktree+git covers the _agent's_ work-state; the _controller's_ state (iteration #, budget spent, termination reason) lives nowhere — needs new `loop_runs`/`loop_iterations` tables (§3.3 mechanics) |
| Loop contract (what "done" means) | verifier + termination logic                                      | **← build this**                                                                                                                                                                                          |
| Checker (automated verify)        | a shell command's exit code                                       | **← build this** (one command; §11 adds richer verifiers)                                                                                                                                                 |
| Human checkpoint                  | approval before irreversible action                               | `blocked`/`needs_human` pauses the loop for the operator; formal Gate primitive deferred (§11)                                                                                                            |

```ts
run: {
  mode: 'once' | 'loop',
  loop?: {
    // P1 is fresh-context only (Ralph): each iteration kills + respawns the agent clean.
    // A `continueContext` mode is deferred (§11) — one code path now.
    verify: string;                // a shell command; exit 0 == pass. Subsumes tests/lint/build.
    maxIterations: number;         // hard cap (always required)
    budget?: { tokens?: number; timeMs?: number };
    noProgress?: { afterIters: number };  // engine diffs the worktree; break if unchanged N iters
    // completion: the fixed callback in §3.1 ({status, reason}) — NOT a schema/OutputContract.
  }
}
```

**Engine behavior each iteration (happy path):** spawn agent clean in the worktree → agent works →
engine **auto-commits the worktree** at the iteration boundary → run `verify` (exit 0) → if the agent
emitted `status:'done'` **and** `verify` passes, stop; else if any termination condition fires, stop;
else respawn clean with the same spec (optionally appending the failing `verify` output). This is
Ralph, made native, safe, and observable — but several octomux realities make the naive "kill +
respawn / on stop" loop wrong. They are load-bearing and specified next.

**Engine mechanics — verified octomux constraints (do not hand-wave these):**

1. **Respawn ordering vs. tmux single-window death.** A single-agent loop task has one tmux window;
   `stopAgent` does `kill-window`, and tmux destroys the whole session when its last window closes.
   Fresh-context respawn must **create the new window first, then kill the old** (or hold a keepalive
   window) so `octomux-agent-<id>` never briefly ceases to exist. There is no "respawn in place"
   primitive today — the engine composes it from `stopAgent` + an `addAgent`-shaped spawn with a
   **new** session id (the default launch path already uses `harness.newSessionId()` with no
   `--resume`, which _is_ fresh context).
2. **Neutralize the status poller.** `pollStatuses` runs every 5s and flips any `running` task whose
   `tmux has-session` check fails to `runtime_state='idle'` with all agents `stopped`. A respawn gap
   would let the poller tear the loop's bookkeeping out mid-iteration. Loop tasks must be **exempt**
   from `pollStatuses` (distinct `runtime_state`, e.g. `looping`, or a poller skip-list) and their
   liveness owned by the loop engine.
3. **Decouple stop/verify from the Stop hook's side effects.** The only end-of-turn signal today is
   the Claude Stop hook (`server/hooks.ts`), which per fire auto-transitions `in_progress →
human_review`, inserts a `task_updates` row, `fireHook('workflow_status_changed')` (→ Jira/Linear/
   Slack writebacks), and kicks the Haiku summarizer. Firing that **every iteration** = N spurious
   status flips + N integration posts. Loop-task agents need a **distinct stop path** that bypasses
   the human_review transition, integration dispatch, and summarizer — gate that logic on
   `mode !== 'loop'`.
4. **Auto-commit is mandatory, not assumed.** Nothing makes the agent commit. If an iteration leaves
   a dirty tree, `sha[N-1] == sha[N]`: the ledger's commit-range diff is empty _and_ `noProgress`
   false-fires and kills the loop. The engine auto-commits at each boundary (the `git add -A` +
   commit pattern already exists in `preflightWorktree`). Working-tree-only changes are invisible to
   a `range:` diff, so this is required for both the ledger (§10.4) and termination to be correct.
5. **Persist controller state + define resume.** Iteration #, budget spent, and termination reason
   are not in the worktree — persist them in **`loop_runs`** (one row per loop) and
   **`loop_iterations`** (one row per iteration: sha range, verifier result, tokens, emitted status).
   On server restart, `resumeTask`/`reconcileOrphanSettingUp` must branch on `mode === 'loop'`:
   default resume uses `--resume` (_continues_ context — the opposite of fresh-context Ralph), so a
   loop must instead resume its controller from `loop_runs` and start a fresh iteration, not
   `--resume` the dead agent.

**Layered termination (the field's #1 lesson — never a single exit):** a loop stops on _any_ of —
`completion.done` **corroborated by the verifier**, `maxIterations` cap, `budget` exhausted, or
`noProgress`. Enforced **centrally** in the engine so every loop inherits all four for free, and the
`budget`/`maxIterations` check runs **before each respawn** (a loop that can't verify progress fails
closed, not spins). The structured completion callback (§3.1) also unlocks multiple exit _states_
(`done` / `blocked` / `needs_human`) that Ralph's single-string `<promise>` match cannot express.

**Iteration Ledger (the surface):** loop mode produces a `feed`/`artifact` surface recording, per
iteration — git diff (what changed), verifier result, tokens/cost, and the agent's emitted status.
This turns an otherwise black-box `while` loop into a debuggable timeline, and is octomux's biggest
unique value-add over a bare bash loop or the single-session `ralph-loop` plugin.

**Externalized progress ledger:** the engine seeds a `PROGRESS.md` / task-list in the worktree that
the agent updates each iteration — externalized state surviving context resets (the field's "state
layer" best practice), doubling as the ledger UI's data source.

**Parallel / best-of-N (later):** the same `LoopSpec` run as N concurrent loops with different
seeds/approaches across the fleet; an `llmJudge` verifier picks the winner. A quality lever the
fleet model makes natural; deferred past P1.

## 4. How the registry hooks UI in (mechanism) — **P3, not P1**

> This is the _eventual_ registry design, built in P3 once loops + extract + reviews give three data
> points (§9, §11). P1 ships concrete `/loops` routes instead (§10.3). Documented here so the target
> shape is clear, not as near-term work.

Parallel to `registerProvider()`, spanning server and client:

- **Server** — a `WorkflowType` descriptor:
  ```ts
  interface WorkflowType {
    kind: string;                 // 'review', 'orchestrator-chat', 'pr-extract'
    displayName: string;
    trigger: TriggerSpec;         // which Trigger + Filter
    run: RunSpec;                 // harness + agent + prompt/skill + isolation; mode 'once'|'loop' (§3.3)
    output?: OutputContract;      // JSON Schema; absent for session-only workflows
    sinks?: SinkSpec[];           // fan-out targets; may declare a Gate
    surfaces: SurfaceKind[];      // ('session' | 'artifact' | 'feed')[]
    apiRouter?: Router;           // optional bespoke endpoints (reviews keep theirs during migration)
  }
  registerWorkflow(wf: WorkflowType)
  ```
- **Client** — a component registry keyed by `kind`:
  ```ts
  registerWorkflowUI(kind, { navLabel, icon, ListView?, DetailView? })
  ```
  `App.tsx` gains **two generic routes** — `/w/:kind` and `/w/:kind/:id` — that look up the
  registered component by `kind`. A generic `useWorkflowItems(kind)` hook hits the workflow's API
  namespace. If a kind registers no `DetailView`, the framework renders the **schema-driven default**
  from its `output` contract. Nav entries are generated from the registry, not hardcoded.

**Reviews refactor** onto this as the reference `artifact`+`feed` implementation: the poller trigger
becomes a registered `TriggerSpec`, the review tables become its `sql` result store, and the review
pages register as its custom `DetailView`/`ListView`. During migration reviews may keep `apiRouter`
pointing at existing `/api/review/*` handlers; new workflows use the generic path.

**Orchestrator chat refactors** as the reference `session` implementation: a `WorkflowType` with
`surfaces: ['session']`, `run` = standalone agent (`task_id=NULL`, `orchestrator` agent), trigger =
manual. Because triggers are pluggable, the same chat can later be fired by a `schedule` trigger
("9am daily planning chat") with no new code. The chat also sits on the _producing_ end of the bus
(it spawns tasks) — noted, but needs no separate framework.

## 5. Candidate workflows (ranked)

1. **Loop harness (reference build — §3.3).** A `LoopSpec` (spec/prompt file + verifier + caps) →
   octomux runs the Run-in-`loop` engine with layered termination and an Iteration Ledger surface.
   Chosen first because it delivers octomux's most differentiated capability (native, observable,
   fleet-isolated Ralph loops), needs only Run-in-`loop` + a shell-command verifier + the fixed
   completion callback + a feed/ledger UI, and is the **substrate** many other candidates ride on — a
   triggered workflow is "a loop with a trigger and a verifier." Ships with a single `verify` shell
   command (exit 0 == pass) and a "New Loop" declarative form. Richer verifiers deferred to §11.
2. **Structured extraction → SQL.** Trigger: PR merged. Output:
   `{ area, risk, has_migration, surface, loc }`. Sink: `sql`. Surface: `feed` + dashboard.
   Exercises the trigger→output→sink path end to end and yields structured analytics over everything
   the fleet touches. First proof of the `sql` sink + schema-driven UI.
3. **Auto-triage.** Linear/GitHub issue opened → agent classifies → Output
   `{ severity, area, dup_of?, estimate }` → Sinks: `linear` label/comment (**gated**) + `sql`.
   Reuses the existing Linear integration as a sink.
4. **PR → release notes / changelog.** Merge trigger → structured notes → Sinks: `file` + `github`
   release. Makes the existing `weekly-update` skill autonomous.
5. **Scheduled repo audit.** `schedule` trigger (deps / security / dead-code) → often a **loop**
   (candidate #1) that iterates until the checker passes → `artifact` + `feed`, **gated** before any
   fix PR. Composes the loop + schedule trigger + gate.
6. **Best-of-N loop / tournament.** Same `LoopSpec` run as N parallel loops with different
   approaches; an `llmJudge` verifier picks the winner. Deferred quality lever on top of #1.
7. **Scheduled "daily planning" orchestrator chat.** `schedule` → spins up the orchestrator-chat
   `session` workflow. Proves session-archetype workflows can be _triggered_, not only manual.

## 6. Packaging strategy

Structurally the six primitives would be TS interfaces + a registry + a generic engine — like
`IntegrationProvider` in miniature. But the engine needs deep hooks into task-runner (worktree/tmux),
db, hook bus, and the React app; a published package cannot _own_ those, **and none of those hooks
exist as ports yet** (§1: `task-runner.ts` mutates DB + tmux + broadcasts inline). The port layer is
the hard, green-field part — not a wiring exercise.

**Decision — build concretely first, abstract in P3, extract only if needed:**

1. **P1 (loop):** do **not** stand up all six interfaces + injected ports up front. Build the loop
   engine concretely against thin internal calls into `task-runner`/`db`, in `server/workflows/`.
   Author the FE components against the surface-component contract so registry adoption is mechanical
   later (§10.3). One workflow is not enough evidence to design a six-primitive abstraction.
2. **P3 (reviews + chat + extract = 3 data points):** extract the `TaskRunner` / `Sink` /
   `SurfaceHost` ports and the primitive interfaces once three real workflows constrain their shape.
   Stand up the `/w/:kind` registry then.
3. **P5 (only if a real third-party need appears):** extract `@octomux/workflow-core` (pure contracts
   - engine). Backend-only plugins package cleanly then; treat this as optional, not a goal.

**Wrinkle that shapes the design:** backend-only plugins (trigger + output contract + sql/slack/jira
sink) package and load cleanly. Plugins that ship **custom React UI** are much harder to load
dynamically from a separate package (module federation / build-time registry territory). This is a
second reason the **schema-driven auto-UI default** matters: it keeps most workflows as pure
declarations + backend (fully packageable), reserving shipped React components for first-party,
in-repo workflows like reviews. **Package the backend cleanly; keep custom UI first-party for now.**

## 7. Non-goals (YAGNI)

- No visual drag-and-drop workflow builder (n8n-style canvas). Workflows are declared in code/config;
  the _UI to toggle/configure_ an existing workflow reuses the `configSchema`-form pattern.
- No dynamic loading of third-party React UI bundles in phase 1.
- No new agent-orchestration engine — the **Run** primitive delegates to existing task-runner/chats.
  The Loop primitive (§3.3) is a controller _around_ the existing lifecycle, not a new runtime.
- No unbounded loops. Every loop requires a `maxIterations` cap; an infinite loop (Ralph's
  no-completion-promise mode) is not a supported configuration.
- No migration of reviews' bespoke API away from `/api/review/*` in phase 1; it keeps `apiRouter`
  and is adopted incrementally.

## 8. Risks & open questions

- **Fresh-context respawn is the least-proven load-bearing claim** — must be prototyped before the
  plan. Depends on the tmux new-window-before-kill sequence, poller exemption, and a distinct
  loop-stop path (all detailed in §3.3 mechanics). If it can't be made reliable, the whole
  differentiator weakens. **De-risk P1 by spiking this end-to-end first.**
- **Stop-hook side effects per iteration.** The Claude Stop hook drives human_review transitions +
  integration writebacks + summarizer (§3.3.3). Loops must bypass these, or every iteration spams
  Jira/Linear/Slack. Concrete, not hypothetical.
- **Crash/resume conflicts with `resumeTask`.** Default resume uses `--resume` (continues context);
  a loop must resume its controller from `loop_runs` and start fresh (§3.3.5). Controller state
  (`loop_runs`, `loop_iterations`) is new, forward-only DB schema — enumerate in the plan.
- **Engine ↔ octomux coupling.** The port boundary does not exist yet (§6). Do not pretend it's
  wiring; it is the hard part. Keep `server/workflows/` imports of `task-runner.ts`/`db.ts` behind a
  thin internal seam in P1, extract real ports in P3.
- **Per-iteration startup floor.** Each fresh respawn pays `waitForShellReady` (≤4.5s) +
  `CLAUDE_INIT_DELAY` (3s prod) ≈ 7s before model latency. `maxIterations × ~7s` is a real
  wall-clock floor — surface it in the ledger's cost math so a "50-iteration" loop isn't a surprise.
- **Schema-driven renderer scope.** How rich can the default `artifact` renderer get before a
  workflow needs a custom component? Define the supported schema → widget mapping explicitly.
- **Gate UX.** Where do gated approvals surface (per-workflow feed vs a global approvals inbox)?
- **Idempotency contract.** Standardize the Filter's idempotency key so re-triggers (force-push,
  re-poll) never duplicate runs — generalize the poller's current dedup.
- **Trigger transport.** Phase 1 keeps polling (reuse `poller.ts`); webhooks are a later Trigger
  implementation, not a rewrite.
- **Loop cost/runaway control.** Fresh-context loops respawn agents repeatedly; the token/time
  budget and `maxIterations` cap must be enforced _before_ each respawn, and cost surfaced live in
  the ledger. A loop that can't verify progress must fail closed, not spin.
- **`noProgress` detection fidelity.** Worktree-diff is the cheap signal, but an agent can thrash
  (churn files without advancing). Decide whether `noProgress` also considers verifier-score trend,
  not just "diff empty".
- **Verifier trust (why P1 is command-only).** An LLM verifier can be gamed by the agent it checks,
  so P1 ships a deterministic shell-command verifier only. An `llmJudge` verifier is deferred (§11)
  and, if ever added, stays advisory unless corroborated by a deterministic check or human gate.

## 9. Phasing

- **P0 — Respawn spike (de-risk before planning the rest).** Prototype fresh-context kill+respawn on
  a throwaway loop task: new-window-before-kill, poller exemption, distinct loop-stop path. Prove the
  session survives and the poller doesn't interfere. Gate the rest of P1 on this working.

1. **P1 — Loop harness, concrete (reference build).** Build the loop engine _concretely_ against thin
   internal calls (no six-interface abstraction, no ports yet — §6). Ships: `LoopSpec` persistence +
   the new forward-only tables **`loop_runs`** / **`loop_iterations`**; the loop engine with layered
   termination + engine-managed auto-commit (§3.3); the **`octomux emit` HTTP endpoint + validation**
   (§3.1 — the fixed `{status, reason}` completion callback, hand-validated; no schema engine);
   the single-command verifier; and the Iteration Ledger. FE = **concrete `/loops` + `/loops/:id` routes**,
   components authored against the surface-component contract for later registry adoption (§10.3).
   Exit criterion: native fresh-context Ralph completes a real repo task with a correct ledger.
2. **P2 — `sql` sink + schema-driven UI.** Reuse P1's emit endpoint; add the `sql` sink + the
   schema-driven `artifact` renderer; ship candidate #2 (PR-extract → SQL). First non-loop workflow.
3. **P3 — Abstract + registry + refactor.** With loop + extract as two data points, extract the
   primitive interfaces and `TaskRunner`/`Sink`/`SurfaceHost` ports; stand up the `/w/:kind` registry
   (§4); register loops; refactor **reviews** (custom `artifact`) and **orchestrator-chat**
   (`session`) onto the framework — the 3rd data point that validates the abstraction.
4. **P4 — Gate + second sink kinds** (linear/slack/github); ship candidate #3 (auto-triage);
   add best-of-N loops (candidate #6).
5. **P5 — Extract `@octomux/workflow-core`** _only if_ a real third-party plugin need appears.

## 10. Frontend

No dedicated loop/ledger UI exists yet, but ~two-thirds of what P1 needs is already built. The
expensive, fiddly parts (terminal streaming, git-diff rendering across arbitrary ranges, list/feed
layouts, schema-driven forms) are done; the net-new work is composing them into a ledger + control
strip plus the (later) generic shell.

### 10.1 Reuse map

| Loop UI need                         | Existing component(s)                                                                       | Reuse                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `session` — live agent view mid-loop | `TerminalView.tsx` + `AgentTabs` (as in `ChatPage`/`TaskDetail`)                            | drop in as-is                                                                                     |
| Per-iteration "what changed"         | `DiffViewer.tsx`, `DiffFileList/Tree`, `DiffRangePicker.tsx`, `diffRangeToParam`            | iteration N's diff **is** git range `sha[N-1]..sha[N]`; render via existing `DiffRange` machinery |
| `feed` — list of loops / iterations  | `SessionsInbox.tsx`, `ReviewsPage` queue, `TaskList`/`TaskCard`, `AgentActivitySummary.tsx` | adapt list/card patterns                                                                          |
| Iteration timeline shell             | `TaskActivityPanel.tsx` (per-task activity list)                                            | closest analog to base the ledger timeline on                                                     |
| "New Loop" declarative form          | `components/fields/*` + `configSchema` form pattern + `Composer`/`BulkCreateDialog`         | schema-driven form infra                                                                          |

### 10.2 Net-new components (P1)

1. **Iteration Ledger** — timeline of rows `{ iteration #, diff (range `sha[N-1]..sha[N]`), verifier
result, tokens/cost, emitted status }`. The marquee new UI; timeline shell adapts
   `TaskActivityPanel`, diff body reuses `DiffViewer` + `DiffRange`.
2. **Loop control strip** — start / stop / pause, `iteration N / max`, budget consumed, live
   termination reason. No loop-control UI exists today.
3. **"New Loop" form** — `LoopSpec` authoring (spec file + verifier + caps) via the schema-form infra.

### 10.3 Routing decision (recommended)

- **P1:** concrete `/loops` (feed) + `/loops/:id` (ledger + control strip + session tab) routes,
  wired explicitly in `App.tsx`. Components authored against the surface-component contract
  (`{ ListView, DetailView }` for `feed`/`artifact`) but registered by hand for now.
- **P3:** stand up the generic `/w/:kind` registry (§4); loops become its first registered kind by
  moving the explicit routes to registrations — mechanical, no component rewrite.

Rationale: avoids front-loading registry infrastructure before the loop UX is validated, while
guaranteeing the P1 components promote into the registry without throwaway work. Consistent with the
§6 "clean module first, promote when seams are proven" stance.

### 10.4 Iteration diff contract

The **engine auto-commits at each iteration boundary** (§3.3.4 — do not rely on the agent to commit;
`range:` diffs see committed changes only, so a dirty tree would show an empty diff). The ledger then
keys each row's diff to the iteration's commit range `sha[N-1]..sha[N]`. An **empty range (nothing
to commit) = a `noProgress` signal** (§3.3), so the diff view and termination logic share one source
of truth. This makes the ledger's diff view mostly wiring over existing `DiffRange` rendering, not
new UI.

## 11. Deferred framework primitives (NOT built in P1/P2)

The framework vision beyond the loop. Each item is catalogued here so the design is coherent, but
**nothing here is built until a shipping workflow needs it** — this is the ponytail boundary. Detail
for the ones already sketched lives in §4 (registry), §5 (candidates), §6 (packaging).

| Primitive                                                                              | First real consumer / phase                     | Notes                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| **Trigger** + **Filter**                                                               | P2 (PR-extract needs "PR merged" + idempotency) | generalize `poller.ts` dedup; webhooks later, not a rewrite              |
| **Output Contract** (schema + `ajv` validation, generic emit)                          | P2 (`sql` sink needs arbitrary schemas)         | P1's fixed `{status,reason}` callback is the seed, not this              |
| **Sink** (`sql`, then `github`/`linear`/`jira`/`slack`/`file`/`webhook`)               | P2 `sql`; rest P4                               | fan-out; reuse existing integrations as sinks                            |
| **Gate** (human approval before an outward sink)                                       | P4 (auto-triage posting to Linear)              | P1 loops have no outward sink; `blocked`/`needs_human` is enough         |
| **Surface registry** (`session`/`artifact`/`feed` as a registered `/w/:kind` contract) | P3 (reviews + chat)                             | P1 uses the shapes informally via concrete `/loops` routes (§3.2, §10.3) |
| **Richer verifiers** (`tests`/`lint`/`typecheck`/`build` presets, `llmJudge`)          | when a loop needs more than one shell command   | P1's single `verify` command already subsumes the deterministic presets  |
| **Continued-context loop mode**                                                        | when a use case wants accumulated context       | P1 is fresh-only; one code path                                          |
| **Best-of-N / parallel loops**                                                         | P4                                              | needs `llmJudge` to pick a winner                                        |
| **`@octomux/workflow-core` package**                                                   | P5, only if a third-party plugin need appears   | optional, not a goal                                                     |

## 12. Generalization roadmap — the harness lens

Framing (per [Lilian Weng, "Agent Harness Engineering", 2026-07-04](https://lilianweng.github.io/posts/2026-07-04-harness/)):
octomux is a **harness** — the OS-like layer around the model that governs control flow, context/memory,
tools, evaluation, and permissions — not merely an orchestrator. The loop harness (P0/P1) is the
control-flow piece. The article validates most of our design and adds two dimensions the earlier spec
did not name: **curated cross-iteration memory** and **self-improvement**.

**What the article confirms we already got right:**

- Evaluator sits _outside_ agent self-report — loop `done` requires the verifier to pass, not just the
  agent's `emit` (mitigates the "over-optimism / numerical duct tape" failure mode and reward hacking).
- Durable state in the file system (per-iteration git commits + the ledger), not in context.
- Fresh context per iteration (Ralph reset) as a context-degradation mitigation.
- Human checkpoints + permission control kept outside the automated loop (Gate primitive, gated sinks).

**Finalized, prioritized next steps:**

| When                      | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Basis                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Finish P1**             | Crash-resume of an in-flight loop (recover controller state from `loop_runs`, start a fresh iteration — never `--resume`). Guard `POST /api/loops` against a second loop on an already-`looping` task (smoke-test finding).                                                                                                                                                                                                                                                                                                                                                                                                                                                | spec §11 + article "recover after interruption" |
| **P2 (highest leverage)** | **✅ DELIVERED — agent learnings store** (`spec/agent-learnings-store.md`, 2026-07-23). Agents write structured, evidenced, linted learnings via `octomux learn` (no per-add gate, `octomux recall` for on-demand pull); seeded into fresh iterations as fenced _data, not instructions_; two-lane cross-pollination (shared repo pool + private `loop:`/`schedule:` lanes); curated by a weekly digest. Supersedes the Generator→Reflector→Curator proposal, and folds in / removes BOTH the old `review_learnings` table and the `.octomux/loop-playbook.md`. Storage is swappable behind `agent-learnings.ts` (Mem0/vector = Phase 2). Verifier hardening remains open. | article **ACE** + reward-hacking                |
| **P3**                    | Trigger→output→sink workflows (PR-extract→SQL) — the harness's I/O edges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | spec §11                                        |
| **P4**                    | Best-of-N / parallel loops with **file-based status records** (explicit, inspectable, recoverable) · generic `/w/:kind` registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | spec §11 + article subagent pattern             |
| **Frontier (spike only)** | Self-improving harness: Propose→Evaluate→Accept over editable surfaces (skills/prompts/hooks), with the article's guardrails — evaluator + permissions **outside** the evolving loop, **bounded editable surfaces**, held-in/held-out regression, human accept-gate. High ceiling, high reward-hacking risk.                                                                                                                                                                                                                                                                                                                                                               | article DGM/STOP/Self-Harness Loop              |

**The one reordering the article drives:** promote the **curated-playbook** (P2) ahead of the
trigger→sink workflows. It is cheap (reuses `review-learnings`), directly attacks the memory-degradation
failure mode, and makes loops cumulative — the highest-ROI next step. The self-improving harness is
named for completeness but is a gated research spike, not committed work, precisely because a
self-improvement loop optimizes whatever signal it is given (reward hacking) — its evaluator and
permission layer must live outside the loop it evolves.
