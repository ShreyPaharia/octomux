# Surface consolidation + centaur primitives — design

Date: 2026-08-12
Status: design approved in outline; verified against `origin/next` @ `bc9ac02`

> **All facts below were re-verified against `bc9ac02` after an initial pass was
> found to be running against a 183-commit-stale tree.** Claims carry `file:line`.
> Where an earlier assumption was disproved, it is recorded under
> "Disproved assumptions" rather than deleted — the wrong version is instructive.

---

## 1. Why

Two goals, one programme:

1. **Shrink the interaction surface.** Every capability should be defined once
   and projected onto the transports that need it, instead of hand-written
   three or four times.
2. **Add centaur primitives.** A human-in-the-loop decision channel, so an agent
   can block on a design question instead of guessing wrong and burning
   iterations.

They are one programme because the centaur primitives are new capabilities. If
they land before consolidation they add three more hand-written surfaces; if
they land after, they cost one registry row each.

## 2. Verified current state

### 2.1 Surface inventory

| Surface                             | Count    | Notes                                                                                                             |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| REST routes in `server/routes/*.ts` | 122      |                                                                                                                   |
| REST routes mounted elsewhere       | 12       | `workflows/reviewer/routes.ts` (7), `workflows/pr-extract/routes.ts` (3), `orchestrator/artifact-endpoint.ts` (2) |
| **Total production REST**           | **134**  | plus 1 test-only seed route                                                                                       |
| Hook endpoints (`server/hooks.ts`)  | 8        |                                                                                                                   |
| CLI leaf commands                   | ~32      | across **two** independent dispatch trees                                                                         |
| MCP tools                           | up to 17 | across **two** independent MCP servers                                                                            |
| Registry-defined capabilities       | 7        | `command-registry.ts:137-264`                                                                                     |

The registry defines 7 capabilities once but only _generates_ two of the four
surfaces it touches:

- generates — MCP write tools (`mcp/server.ts:365-383`), gate policy sets
  (`command-registry.ts:276-316`), `ORCHESTRATOR_ACTIONS` (`actions.ts:51`)
- does **not** generate — CLI commander definitions (hand-written, partially
  drift-tested in `cli/src/commands/command-schema-drift.test.ts`, which covers
  only 2 of 6 commands in depth), and REST routes (entirely separate,
  hand-written validation)

### 2.2 Two CLI trees

`bin/octomux.js:19-28` switches on `argv[0]`: `start` → server, `review` →
`cli/review/index.ts`, everything else → `cli/dist/index.js`.

- `cli/src/` — commander, 30 `registerX(program)` calls, talks to the server
  through `cli/src/client.ts`
- `cli/review/` — bespoke `switch(sub)` (`index.ts:25-53`), 8 subcommands,
  talks to the server through **raw `fetch()`**, bypassing `client.ts` entirely

### 2.3 Two MCP servers

- `server/orchestrator/mcp/server.ts` — 9 read tools always; 6 conductor write
  tools when `orchestratorWriteEnabled()`; `report_complete` only when
  `workerReportEnabled()`. The two write modes are mutually exclusive by env var
  (`write.ts:63-80`).
- `server/agent-session/mcp/submit-result-server.ts` — separate stdio server,
  1 tool (`submit_result`), low-level `Server` class + Ajv, not the
  `McpServer`/zod pattern used by the other.

### 2.4 The generic work surface already exists

`WorkflowType` (`workflows/types.ts:22-45`) registers `kind`, `surfaces`,
`execution: 'session'|'task'|'chat'`, `trigger: cron|github|manual`,
config/output JSON Schemas, optional `apiRouter`, and `run(ctx)`. Nine kinds are
registered (`workflows/index.ts:2-11`).

It is extensible from disk: `~/.octomux/kinds/*.json` overlays or synthesises a
kind (`presets.ts:191-239`), proven live by `kinds/custom.json`, which is a bare
`{kind, displayName, execution:'session'}` with no code behind it. **Constraint:**
home-tier presets are restricted to `execution: 'session'` (`presets.ts:100-102`);
`task`/`chat` kinds still require a registered code handler.

`runs` (`schema.ts:189-204`) is genuinely kind-agnostic — `workflow_kind` is a
free string with optional FKs to each execution substrate (`schedule_id`,
`task_id`, `chat_id`, `loop_run_id`).

**But writing to `runs` is opt-in per code path:**

| Path                                   | `runs` row?                                            |
| -------------------------------------- | ------------------------------------------------------ |
| Cron schedule fire                     | yes                                                    |
| Schedule "run now"                     | yes — same `executeScheduleRun` path                   |
| Github-triggered reviewer / pr-extract | yes                                                    |
| Plain manual task creation             | **no**                                                 |
| Manual loop (`POST /api/loops`)        | **no**                                                 |
| Manual review (`createManualReview`)   | **no**                                                 |
| Orchestrator-managed tasks             | **no** — zero `insertRun` under `server/orchestrator/` |

### 2.5 The DAG already exists, in a silo

`managed_tasks.depends_on` (`migrations.ts:799`) is a JSON array of task ids.
`scheduleDagStep()` (`orchestrator/mcp/verify.ts:189-290`) cascades `blocked` to
dependents on failure and dispatches when `allDepsDone`.

Single-level, scoped to one `orchestrator_conversations` row, with **no
connection to `runs`, `schedules`, or the kind registry**. No `parent_id` /
`blocked_by` columns exist anywhere else.

### 2.6 Human-in-the-loop: what actually exists

**The permission inbox is telemetry, not a gate.**
`POST /api/hooks/permission-request` (`hooks.ts:239-267`) inserts a row, sets
agent activity to `waiting`, returns `200` with an empty body. It never returns
a decision. What blocks is Claude Code's own terminal dialog. Resolution is
either a human typing into the tmux pane, or `post-tool-use` calling
`resolveOldestPendingByAgent` as a side effect of the CLI proceeding.
`SessionsInbox.tsx:44-61` has no approve/deny control — "Reply →" navigates to
the terminal. There is no `resolvePermissionPrompt(id, decision)` function.

**The Bash gate is dead code.** `runner.ts:12-13` states the conductor is
PURE-MCP with no PreToolUse hook; its settings hard-deny `Bash`/`Edit`/`Write`.
Writes RPC to `POST /api/hooks/orchestrator-action` and **execute immediately,
no approval** (`write.ts:6-8`).

**What survives and is reusable** — the card machinery, currently serving
exactly one case (the `approve-plan` relay from `supervisor.ts:332-345`):

- `action_cards` table + `createCard` / `resolveCard` / `executeCard`
  (`gate.ts:194-207`, `222-326`)
- `rehydratePendingCards()` at boot (`gate.ts:433`, called `index.ts:119`) —
  pending decisions survive restart, in SQLite not memory
- `approval-timeout.ts` — DB sweep auto-rejecting cards older than
  `approvalTimeoutMs()` (default 30 min), restart-safe by design
- WebSocket `card_decision` → `executeCard` (`stream.ts:606-624`)

**No ask-human primitive exists.** Zero grep hits for ask/elicit/clarify. The
only block-on-human is the coarse quiescence flip to `human_review`
(`poller/quiescence.ts:16,51-68`), reversed when the user next replies
(`hooks.ts:210-233`).

### 2.7 MCP attachment

`applyOrchestratorMcpConfig` (`launch.ts:193-206`) gates strictly on
`isOrchestratorManaged(taskId)`. Plain tasks get **no MCP server at all**.
Workers that do get one receive only `report_complete`.

Cursor (`harnesses/cursor.ts:94-102`) has **zero** MCP wiring — no
`--mcp-config`, no config writer. Its `installHooks` wires Cursor's own hook
bridge, which is telemetry, not MCP.

**Latent bug:** `applyOrchestratorMcpConfig` checks only `isOrchestratorManaged`,
never `harness_id`. An orchestrator-managed Cursor task would get
`--mcp-config <path>` appended to a `cursor-agent` command line that has no such
flag.

### 2.8 Task narrative is scattered across five stores

`tasks.current_summary` (single overwritten field) · `task_updates` (append log;
`kind` takes exactly three values — `transition`, `summary`, `note`) ·
worktree-root `plan.json` (not in the DB; `managed_tasks` holds only a path
pointer) · `review_runs.walkthrough` (per-sha JSON blob) · `pr_extracts`
(post-merge classification, one row per task).

There is an established `.octomux/` worktree-file convention already:
`implement-done`, `loop-status.json`, `ingested-comment-ids.json`, `hooks/`,
`agents/`.

### 2.9 Multi-PR

`pull_requests` (`schema.ts:206-221`, added 2026-07-31 "Multiple PRs per task")
with `UNIQUE(task_id, branch)`. Populated by `poller/pr-detection.ts`, which
enumerates the task branch **plus** slice branches matching `agents/<taskid>-*`.

`tasks.pr_url` / `pr_number` / `pr_head_sha` are a **deliberate derived cache**
refreshed by `syncDerivedPrimaryPr()` (`repositories/pull-requests.ts:113-153`)
so existing readers keep working.

**Storage supports N PRs. Every downstream consumer reads only the derived
primary** — review runs, publish-review, pr-extract, MCP `get_task`.

`task_external_refs` PK is still `(task_id, integration)` — one ref per
integration. `POST /api/tasks/:id/refs` uses `INSERT OR REPLACE`, so a manual ref
silently overwrites one inferred from the branch name at task creation.

### 2.10 Sessions

`closeTask()` (`task-engine/cleanup.ts:31-74`) unconditionally kills the tmux
session. One tmux session = one task, always; multiple agents are _windows_
within it. No session reuse, detach, or cross-task mechanism exists anywhere in
`task-engine/`.

---

## 3. Disproved assumptions

Recorded because each shaped an earlier version of this design.

| Assumption                                                                                     | Reality                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate.ts` already implements a working centaur gate; the centaur work is mostly generalization | The Bash gate is unreachable dead code. Only the `approve-plan` card path is live. The centaur work is mostly **build**.                                       |
| The permission inbox is a block-until-human channel with UI, reusable for `ask_human`          | It is fire-and-forget telemetry with no decision control. `ask_human` must extend `action_cards`, not `permission_prompts`.                                    |
| Hooks collapse 8→1 because Claude Code sends `hook_event_name` in the body                     | `hook_event_name` appears **once in the whole file, in a comment** (`hooks.ts:621`), never read from `req.body`. Realistic collapse is 8→4.                    |
| `tasks.pr_url` blocks multi-PR and should be dropped                                           | `pull_requests` already exists; `tasks.pr_*` is an intentional derived cache.                                                                                  |
| `summary`/`note`/`base`/`viewed` are thin field writes that fold into `PATCH /api/tasks/:id`   | They write different stores. `/base` does git-ref resolution + cache invalidation for a _running_ task; `PATCH`'s `base_branch` is draft-only. Not duplicates. |
| Bulk ops (`delete-done`, `restore`, `viewed-all`) are redundant                                | No overlapping logic. False lead.                                                                                                                              |
| `/api/agents` namespace collides three ways                                                    | Already disambiguated: `/api/agents` (conductor agents), `/api/workers` (per-task tmux), `/api/agent-roles` (role skeletons).                                  |
| `octomux learn`/`recall` don't exist (drift)                                                   | Shipped, with `agent_learnings`.                                                                                                                               |
| `team_runs` / `team_schedules` need removing                                                   | Already dropped (`migrations.ts:973-975`).                                                                                                                     |
| §7's `tasks.kind` / `trigger` / `schedule` columns are needed                                  | Reinvents `WorkflowType` + `runs` + `schedules`. The gap is **adoption**, not abstraction.                                                                     |

## 4. Verified duplication worth acting on

Ordered by value, not by route count.

1. **Two differently-scoped "does this review exist" queries** —
   `findExistingReviewTask` (`repositories/tasks.ts:219`, scoped
   `repo_path`+`pr_number`) vs `lookupExistingReviewId` (`routes/_shared.ts:64`,
   scoped `pr_number` alone **or** by source-task link). Same concept, different
   answers. This is a correctness risk, not tidiness.
2. **`PATCH /api/tasks/:id` silently bypasses transition tracking** —
   `tasks.ts:291` comment: _"Direct workflow_status flip (simpler version
   without note/transition tracking)"_. `POST /:id/move` requires a note for
   `human_review`/`planned`, writes a `task_updates` transition, fires the
   `workflow_status_changed` hook, and auto-starts the task. The `PATCH` path
   does none of it.
3. **`default_branch` implemented twice** — `misc.ts:169-187` and
   `mcp/read.ts:445-463` each run the same `git symbolic-ref` + `'main'`
   fallback.
4. **Branch listing re-implemented** — `misc.ts:113-125` re-derives what
   `listBranches()` (`git-commits.ts:86-110`) already does, minus sorting and
   current-branch resolution.
5. **Review creation duplicated** — `createReviewTaskFromPr` and
   `createManualReview` (`reviewer/run.ts:61` / `:123`) both build
   `review/${short}-pr-${number}` and call `buildPrReviewPrompt` with
   near-identical args.
6. **`agent-defs.ts` / `skills.ts`** — identical 2-route list+get shape over
   different filesystem loaders. Boilerplate, not data duplication.
7. **Orphaned capability** — `request-review` is in `POLICY_ONLY_COMMANDS`
   (`command-registry.ts:132`) with a handler at `mcp/verify.ts:104`, wired to
   **no surface at all**. Dead.
8. **Hooks** — 5 of 8 share an identical envelope and could merge; 3 cannot:
   `/session-start` (401 + JSON `{}` for Cursor), `/pre-tool-use`
   (`hookSpecificOutput` protocol envelope), `/orchestrator-action` (RPC, not a
   hook). `/stop` additionally bypasses auth when `body.agent_id` is present
   (`hooks.ts:306-312`).
9. Two hook-auth mechanisms — `requireHookToken` (`?token=`) and
   `requireBearerHookToken` (`routes/hook-auth.ts:12`, `Bearer` header).

## 5. Design

### 5.1 Capability registry — one definition, four projections

Supersedes `command-registry.ts`, same define-once idea widened.

```ts
{
  id:      'task.create',
  http:    { method: 'POST', path: '/api/tasks' },
  cli:     'task create',          // omit → not a CLI command
  mcp:     'create_task',          // omit → not an MCP tool
  tier:    'ask',                  // gate policy
  callers: ['ui', 'human', 'agent'],
  input:   createTaskInputSchema,  // zod, exists today
  handler: runCreateTask,          // exists today
}
```

Generates the Express route, the commander subcommand, the MCP tool, and the
gate classification. `command-schema-drift.test.ts` is deleted — with one
source there is nothing to drift.

**Caller identity is the load-bearing new concept.** One row now serves the UI,
the CLI, and MCP; the row must know who is calling, because an agent invoking
`task.create` should hit the `ask` tier and a human clicking the same button
should not. Fail-closed: unidentified caller is treated as `agent`.

Positive identification is required for the two non-agent classes, because a
fail-closed default alone would gate the dashboard's own calls. The
`X-Octomux-Client` header is set by `createRequestCore` in
`@octomux/api-client`, the single choke point both the SPA and the CLI already
use. An agent token always wins over the header.

**Escape hatch, explicitly declared.** Streaming, wildcard and binary routes
(`GET /api/tasks/:id/diff/*path`, SSE, PTY WebSockets, `/api/browse`) stay
hand-written but must be _registered as out-of-registry_, so "unlisted" is a
test failure rather than a silent gap. That is what makes the surface complete
rather than merely smaller.

### 5.2 Noun-verb collapse

```
task    create get list close resume delete note move ref summary updates start
worker  add stop message
plan    get set
ask     raise
review  start walkthrough draft-comment check-previous complete learning playbook
skill   list get
repo    recent default-branch files branches
```

`cli/review/` is deleted; its 8 subcommands become registry rows under the
`review` noun, and `bin/octomux.js` loses its `review` special case.

Old flat names (`create-task`, `list-tasks`, …) are kept as permanent hidden
aliases — they are baked into third-party prompts and configs outside this repo.

### 5.3 MCP exposure is narrower than CLI

MCP tools cost context on every agent turn, so `mcp:` is set only where an agent
genuinely needs the capability. Target ~14 tools. `review_*` collapses its 8
subcommands into one tool with a discriminated-union input.

**Do not compress further.** Merging `task_get`/`task_list`/`task_create` into a
single `task` tool with a verb argument makes the count prettier and tool
selection worse.

### 5.4 `ask_human` — a blocking decision channel

Extends `action_cards` (live, restart-safe, timeout-safe), **not**
`permission_prompts` (telemetry).

```
agent → mcp__octomux__ask_human({ question, options[], context?, default? })
      → registry row ask.raise (tier always-ask)
      → createCard(kind='question')  + WS push → UI
      → MCP handler awaits resolution
      → human answers → executeCard → returns { answer, note? }
```

- **Restart** — pending rows rehydrate via `rehydratePendingCards`. The agent's
  MCP subprocess dies with the server; on reconnect it re-asks and dedupes on
  `(task_id, question_hash)`.
- **Timeout** — reuse `approval-timeout.ts`. On expiry return the declared
  `default`, else an explicit "no human answered, use your judgement" payload.
  Never hang forever.
- **Activity state** — set `hook_activity='waiting'` as `permission-request`
  does, so the Monitor grid distinguishes blocked-on-human from
  blocked-on-permission.

The MCP projection's `onGatedInvoke(cap, tier, input)` hook is the seam this
attaches to.

Rejected alternative: **MCP elicitation**. Protocol-native, but it renders in
_the client's_ UI — Claude Code's terminal — which puts the question back in the
pane the unified inbox exists to escape.

### 5.5 One task artifact

One `.octomux/artifact.md` per task in the worktree, not a DB column: git
tracks it, it diffs, it survives a DB wipe, the human edits it in the existing
saved-files editor, and it fits the established `.octomux/` convention.

Sections: **Plan / Open questions / Progress / Summary / PRs / Walkthrough**.
Rendered on the info tab. Two MCP tools: `artifact_get`, `artifact_patch`.

Retires: `tasks.current_summary` (+ `_updated_at`), `task_updates` rows of kind
`summary` and `note`, worktree `plan.json`, `review_runs.walkthrough`.

**`task_updates` rows of kind `transition` stay** — they are the kanban's
history, not narrative.

`open_questions` becomes the batched sibling of `ask_human`: entries render as
cards too, so a planning agent raises five questions without five blocking
round-trips.

### 5.6 Generic work surface — adoption, not abstraction

1. One shared _start-a-run_ path that manual task creation, manual loops, and
   manual reviews also flow through, so `runs` becomes exhaustive.
2. A bridge between the orchestrator island (`managed_tasks`,
   `orchestrator_conversations`) and `runs`/`schedules`.
3. Promote `depends_on` out of `managed_tasks` so the DAG is available to the
   generic surface.

**DAG: the column, not the engine.** Execution is a poller check — _tasks whose
deps are all done → start_. No DAG engine, no visual editor, no fan-out policy,
no cycle detection beyond a depth cap, until a real workflow needs one.

### 5.7 Sessions outliving tasks

`closeTask` detaches instead of killing, so a long-running session can span
multiple tasks and PRs. Entirely new — no mechanism exists to build on.

### 5.8 MCP-only for agents

Decision: agents talk to octomux exclusively through MCP. Consequences accepted:

- Cursor MCP support (`harnesses/cursor.ts`) is a **blocking dependency**.
- Worker MCP attachment becomes unconditional — drop the
  `isOrchestratorManaged` gate at `launch.ts:199`.
- The three MCP wirings (conductor, worker `report_complete`,
  `agent-session` `submit_result`) converge to one.
- Skills migrate off the CLI. `review-learnings/SKILL.md:50` additionally
  bypasses both and curls `/api/tasks` directly.
- External skills shelling out to `octomux …` break on upgrade.

### 5.9 API reduction — 134 → ~100

| Move                                                                                                                                                                                                       | Routes | Δ   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| Chats fold into tasks (already the same storage — `createChat` returns an `Agent`, no `chats` table exists)                                                                                                | 6 → 1  | −5  |
| Document CRUD collapse — `kinds` + `skills` + `agent-roles` + `saved-files` are four copies of list/get/put/delete over named files → `/api/docs/:kind[/:name]`                                            | 10 → 4 | −6  |
| `loops` + `loop-groups` → `runs` (follows §5.6 adoption)                                                                                                                                                   | 10 → 5 | −5  |
| Reviewer — the two creation paths merge (§4.5); the walkthrough PATCH dies with the artifact                                                                                                               | 7 → 4  | −3  |
| `orchestrator/artifact-endpoint` dies with the artifact                                                                                                                                                    | 2 → 0  | −2  |
| `task-workflow` — `/summary` and `/note` die with the artifact                                                                                                                                             | 8 → 6  | −2  |
| `learnings` — two GETs → one with a query param, two POSTs → one accepting an array                                                                                                                        | 6 → 4  | −2  |
| One each: terminals pair, file-reviewed toggle, viewed/viewed-all, repo-config/repo-configs, preflight pair, branches pair, `workflows/:kind/runs`, integrations prefill→invoke, pr-extract emit→runs emit |        | −9  |

**~100 is the floor** without merging things that genuinely differ.

**Route count is the wrong metric once the registry exists.** 100 rows generated
from one definition each is a far smaller surface than 134 hand-written ones.
What a person actually holds in their head is **8 nouns** — `task`, `worker`,
`run`, `review`, `artifact`, `docs`, `repo`, `integration`. The CLI (~32) and
MCP (~14) projections stay deliberately narrower.

## 6. Sequencing

| #   | Spec                  | Contains                                         | Depends on |
| --- | --------------------- | ------------------------------------------------ | ---------- |
| 1   | Capability registry   | §5.1, §5.2, §5.3, dedupe items 3–8               | —          |
| 2   | Work-surface adoption | §5.6, §5.7                                       | 1          |
| 3   | Task artifact         | §5.5, multi-PR consumer wiring, dedupe items 1–2 | 1, 2       |
| 4   | Centaur               | §5.4, §5.8, cursor MCP, unconditional worker MCP | 1, 3       |

**Spec 1 keeps the CLI intact; spec 4 removes it as an agent surface.** If 1
ships and 4 slips, agents must still have a working path.

Riskiest single change: multi-PR consumer wiring in spec 3 — it touches the PR
poller and `review_runs.pr_head_sha`.

## 7. Open questions

- Do `loop_runs` + `loop_iterations` fold into `runs`, or stay as the execution
  substrate `runs` logs on top of? (Current recommendation: stay.)
- Does the orchestrator island get bridged to `runs`, or migrated onto it?
- Is `request-review` (dead capability, §4.7) revived as a registry row or
  deleted?

## 8. Process note

The first pass of this document was written against a worktree 183 commits
behind `origin/next`, which invalidated roughly a third of its findings (§3).
The second loss was worse: the entire checkout was deleted while the work was
still uncommitted, and only the subagent transcripts in `~/.claude/projects/`
made recovery possible.

Two rules follow, and they cost nothing:

1. `git fetch` and compare against the target branch **before** surveying a
   codebase. A stale tree produces confident, wrong analysis.
2. Commit as soon as work verifies, independently of whether it is ready to
   ship. Deciding about the PR later is free; recovering deleted uncommitted
   work is not.
