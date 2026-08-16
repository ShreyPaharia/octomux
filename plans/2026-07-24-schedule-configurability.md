# Schedule Configurability — Implementation Plan

> Executes `spec/schedule-configurability.md` (FINAL, 5-persona reviewed). Parallel
> sonnet work packages with **disjoint file sets**, two waves + an integration pass.
> Every package agent reads the spec first; this plan pins the decomposition and the
> cross-package interfaces so packages compose without coordination.

**Goal:** every hardcoded schedule knob becomes DB-backed and UI-editable; add the
generic `custom` cron kind.

**Execution rules (all packages):**

- Work directly in this worktree. Edit ONLY the files listed for your package.
  Do NOT commit, do NOT run `git add`, do NOT run `tsc`/`bun run typecheck` (other
  packages land concurrently; the integration pass owns repo-wide checks).
- Run only your own test files: `bun run test -- <path>` (vitest).
- Do not edit `server/test-helpers.ts` or `src/test-helpers.tsx`; keep new fixtures
  local to your test files.
- Follow repo conventions: pino `childLogger`, template-literal SQL with
  `datetime('now')`, table-driven `it.each`, Prettier style.

## Pinned cross-package interfaces

```ts
// server/repositories/schedules.ts (A1)
interface ScheduleRow {
  id: string; kind: string; repo_path: string;
  name: string | null; cron: string; timezone: string | null;
  enabled: number; model: string | null; timeout_ms: number | null;
  last_run_at: string | null; config_json: string | null; prompt: string | null;
}
createSchedule(input: CreateScheduleInput): ScheduleRow   // pure insert; SELECT by id
interface CreateScheduleInput { kind: string; repoPath: string; cron: string;
  name?: string; timezone?: string; enabled?: boolean; model?: string;
  timeoutMs?: number; config?: Record<string, unknown>; prompt?: string }
updateSchedule(id, patch: UpdateScheduleInput): ScheduleRow | undefined
interface UpdateScheduleInput { name?: string | null; repoPath?: string; cron?: string;
  timezone?: string | null; enabled?: boolean; model?: string | null;
  timeoutMs?: number | null; config?: Record<string, unknown>; prompt?: string | null }

// server/schedules/cron.ts (A1)
isCronDue(expr: string, now: Date, timezone?: string | null): boolean

// server/workflows/types.ts (A1)
WorkflowType.execution?: 'session' | 'task' | 'chat'
RunContext.model?: string | null
RunContext.timeoutMs?: number | null

// server/prompt-interpolate.ts (A2, new file)
interpolatePrompt(body: string, vars: Record<string, unknown>): string  // single pass

// server/schedule-prompt.ts (A2)
resolveSchedulePromptWithSource(input: { scheduleId?: string | null; kind: string }):
  Promise<{ content: string; source: 'override' | 'kind_skill' }>
// resolveSchedulePrompt stays, becomes a thin wrapper returning .content

// server/services/session-vertical-service.ts (A3)
RunSessionVerticalInput.timeoutMs?: number | null   // model already exists

// server/chats.ts (A3)
CreateChatOptions.model?: string | null

// server/workflows/slack-watcher/run.ts (B2)
previousItemsJson(scheduleId: string | null | undefined): string

// Validation constants (B1 route-level; B3 embeds refname pattern in config schemas)
MODEL:    /^[a-zA-Z0-9._:/-]{1,128}$/
REFNAME:  /^[a-zA-Z0-9._/-]{1,80}$/        // JSON Schema "pattern" on baseBranch/branchPrefix
TIMEOUT:  integer, 10_000 <= v <= 86_400_000

// API shapes (B1 serves, A4 consumes — build from the spec, not from each other)
GET /api/schedules/kinds → { kinds: [{ kind, displayName, configSchema,
  execution, promptRequired, supportsTimeout }] }
GET /api/schedules/:id/effective-prompt → { content: string, source: 'override' | 'kind_skill' }
```

---

## Wave 1 — 4 parallel packages

### A1 — Data layer, cron timezone, run-context threading

**Files:** `server/db/schema.ts`, `server/db/migrations.ts`, `server/db.test.ts`,
`server/repositories/schedules.ts` + `.test.ts`, `server/schedules/cron.ts` + `.test.ts`,
`server/poller/schedule-cron.ts` + `.test.ts`, `server/poller/execute-schedule-run.ts`

- `.test.ts`, `server/workflows/types.ts`, plus **one-line** `execution:` additions to
  the workflow objects in `server/workflows/{slack-watcher,weekly-update,overnight-log-summary}/index.ts`
  (`'session'`), `{doc-drift,prod-log-triage}/index.ts` (`'task'`), `daily-plan/index.ts`
  (`'chat'`). Touch nothing else in those six files.

Spec sections: §2 (SCHEMA constant + idempotent transaction-wrapped rebuild, delete
`upsertSchedule`, `createSchedule` SELECT-by-id, full `updateSchedule`, extended
`SCHEDULE_COLUMNS`), §3 (isCronDue timezone + compound cache key, pollSchedules passes
`row.timezone`, same-minute refire guard on `last_run_at`), §5 items 1–2
(`executeScheduleRun` populates `ctx.model`/`ctx.timeoutMs` from the row and logs run
start with `prompt_source: row.prompt ? 'schedule_override' : 'kind_skill'`).

Route `routes/schedules.ts` still calls `upsertSchedule` after this package — leave a
temporary `export const upsertSchedule = createSchedule`-style alias ONLY if renaming
breaks its import, and note it; B1 removes the alias. Prefer: keep exporting a
`createSchedule` and change nothing in routes (B1 owns that file).

Tests (extend existing files): migration idempotency + row survival + duplicate
(kind, repo_path) inserts; cron tz cases incl. DST + compound cache key; same-minute
guard; executeScheduleRun threading + run-start log line.

### A2 — Prompt resolution + interpolation

**Files:** `server/schedule-prompt.ts` + `.test.ts`, **new** `server/prompt-interpolate.ts`

- **new** `server/prompt-interpolate.test.ts`.

Spec §4: precedence rewrite of `resolveSchedulePrompt` (schedule override → kind skill)
and `skillContentOverridesForScheduleId` (return `{ [kind]: schedule.prompt }` when
non-empty); add `resolveSchedulePromptWithSource`; debug-log the branch taken.
`interpolatePrompt`: single pass (split-on-token or one `String.replace` sweep with a
callback — never loop until fixpoint), scalars via `String()`, objects via
`JSON.stringify`, unknown `{{tokens}}` untouched.

Note: `ScheduleRow.prompt` is added by A1 concurrently. If the field isn't on the type
yet, code against it anyway (`schedule.prompt`) — vitest strips types, and the
integration pass typechecks after both land. Do not edit `repositories/schedules.ts`.

Tests: precedence table (override / skill / lazy-seed), overrides map honors
`schedule.prompt`, interpolation table incl. single-pass case (`vars.a = '{{b}}'`
stays literal), repeated keys, object stringification.

### A3 — Harness quoting, session timeout, chat model

**Files:** `server/harnesses/shared.ts` + `.test.ts`,
`server/services/session-vertical-service.ts` + `.test.ts`, `server/chats.ts`.

Spec §5: `applyModel` wraps the value with `shellQuoteSingle` (import from
`server/shell-quote.ts`) — update existing `shared.test.ts` expectations accordingly
and add a metacharacter case asserting the quoted output. `RunSessionVerticalInput`
gains `timeoutMs?: number | null`, forwarded as `timeoutMs: i.timeoutMs ?? undefined`
to `runAgentSession` (which already accepts it and defaults internally).
`CreateChatOptions` gains `model?: string | null`; apply it to the launch flags the
same way task launch does (find the flags assembly in `createChat` and pass through
`applyModel(flags, opts.model)`).

Tests: quoting cases; session-vertical passes timeoutMs through (mock
`runAgentSession` per existing test patterns in `session-vertical-service.test.ts`).
`chats.ts` has no dedicated test file — cover the model flag via a focused new
assertion only if an existing api test file already exercises createChat; otherwise
rely on the applyModel unit tests (do not create `server/chats.test.ts` — keep the
package small).

### A4 — Frontend

**Files:** `src/lib/api/schedulesApi.ts`, **new** `src/lib/models.ts`,
`src/pages/SchedulesPage.tsx` + `.test.tsx`,
`src/components/schedules/SchemaConfigForm.tsx` + `.test.tsx`,
**new** `src/components/schedules/TimezoneField.tsx` (+ **new** `.test.tsx`).

Spec §9 in full, building against the pinned API shapes above (server lands in the
same release): extended `ScheduleRow`/`ScheduleKindInfo`/`CreateScheduleInput`/
`UpdateScheduleInput` (all new fields nullable/optional), `getEffectivePrompt(id)`
API fn; create-panel field-visibility matrix (Advanced disclosure for name/model/
timeout; custom ⇒ name + prompt required, submit disabled while empty); timezone
searchable combobox with "Use browser timezone" and `Zone (UTC±H:MM)` labels;
edit-card prompt override editor (lazy effective-prompt preview, Override copies
default into textarea, Reset-to-default confirm → `prompt: null`); multi-instance
card/delete-dialog disambiguation (cron shown when names collide); kind as
non-interactive badge; `SchemaConfigForm` renders `format: 'single-line'` strings as
`Input` (replace the hardcoded `verify`/`logCommand` name checks); `KNOWN_MODELS`
datalist (`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5-20251001`).

Tests: mock `Intl.supportedValuesOf` (undefined in JSDOM); follow existing
`SchedulesPage.test.tsx` + `src/test-helpers.tsx` patterns (`mockApi`).

---

## Wave 2 — 3 parallel packages (starts only after all of Wave 1 lands)

### B1 — Routes

**Files:** `server/routes/schedules.ts`, `server/api.schedules.test.ts`.

Spec §8 + validation from §3/§5/§7: POST switches to `createSchedule` (201 always;
remove any A1 compat alias); PATCH accepts `name/repoPath/cron/timezone/model/
timeoutMs/config/prompt`; cron+timezone validated on both verbs via
`new Cron(expr, { timezone, paused: true })` in try/catch → `badRequest` (import
`Cron` from `croner`); model regex; timeout bounds; custom ⇒ non-empty `prompt` and
`name` required when enabled; kinds endpoint adds `execution`, `promptRequired`
(`kind === 'custom'`), `supportsTimeout` (`execution === 'session'`); new
`GET /api/schedules/:id/effective-prompt` via `resolveSchedulePromptWithSource`.
Config `pattern` violations (refname fields) already surface through the existing
`validateWorkflowConfig` 400 path — add a test, not new code.

### B2 — Session-vertical + chat workflows

**Files:** `server/workflows/slack-watcher/{index,run}.ts` + both `.test.ts`,
`server/workflows/weekly-update/{index,run}.ts` + tests,
`server/workflows/overnight-log-summary/{index,run}.ts` + tests,
`server/workflows/daily-plan/{index,run}.ts` + tests.

Spec §4.2 + §5 items 3–4: thread `ctx.model`/`ctx.timeoutMs` through each input struct
into `runSessionVertical`; daily-plan passes `model` to `createChat`. Replace the
`.replace()` chains with `interpolatePrompt(skillContent, { ...config, ...extras })`
(slack-watcher extras: `previousItems`). `previousItemsJson(scheduleId)` filters via
`listRunsForSchedule` (import from `../../repositories/runs.js`), falling back to `[]`
when `scheduleId` is null. Keep each workflow's `execution` field as set in Wave 1.

### B3 — Task-backed config + custom kind

**Files:** `server/workflows/doc-drift/{schema,index,run}.ts` + `index/run` tests,
`server/workflows/prod-log-triage/{schema,index,run}.ts` + tests,
**new** `server/workflows/custom/index.ts`, **new** `server/workflows/custom/run.ts`,
**new** tests for both, `server/workflows/index.ts` (add `import './custom/index.js';`).

Spec §6: `baseBranch` (default `'main'`) + `branchPrefix` (defaults `'doc-drift'` /
`'triage'`) with `"format": "single-line"` and `"pattern": "^[a-zA-Z0-9._/-]{1,80}$"`;
thread both through run.ts (branch = `` `${branchPrefix}/${short}-${dateStamp}` ``);
thread `ctx.model` into the task insert (both `insertDocDriftTask`/`insertTriageTask`
already write task rows — add `model` to the insert params and the tasks INSERT column
list they use). Spec §7: custom kind — `execution: 'session'`, reads
`getSchedule(ctx.scheduleId).prompt` directly (fail the run if empty), interpolates
extras only, output schema = `RUN_RESULT_SCHEMA` (import from `@octomux/types`) with
`additionalProperties: false` + required `['outcome','summary']`, owns its runs row
(`insertRun` on entry, `finishRun('failed')` in catch; on success `runSessionVertical`'s
existing run handling applies — mirror how weekly-update's run row lifecycle works and
keep behavior consistent with it).

---

## Wave 3 — Integration (orchestrator, sequential)

1. `bun run typecheck` — fix cross-package seams (expected: A2's `schedule.prompt`
   before/after A1 types, route/type drift).
2. `bun run test` full suite; `bun run lint:fix`; `bun run format`.
3. Update `CLAUDE.md` Schedules section (multi-instance, timezone, custom kind,
   per-schedule prompt) and `MEMORY` note about schedule-skills if behavior nuance
   changed (it didn't — overrides layer on top).
4. Conventional commits (no AI attribution), logically grouped (data layer / prompts /
   workflows / routes / UI), or a single `feat(schedules)` commit if the tree bisects
   poorly.
