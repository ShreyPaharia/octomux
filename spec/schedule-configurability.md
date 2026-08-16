# Schedule Configurability

Status: FINAL — revised after 5-persona review (backend architect, security, UX, SRE, YAGNI)
Date: 2026-07-24

## 0. Problem

An audit of the schedules surface found a split between what a schedule row can express and
what the runtime actually honors. Today a schedule is `(kind, repo_path)`-unique with an
editable cron, enabled flag, and kind-specific `config_json`; the per-kind prompt body lives
in `schedule_skills` (DB-authoritative, editable in Settings). Everything else is hardcoded:

| #   | Hardcoded thing                            | Where                                                                                            |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | One schedule per `(kind, repo_path)`       | `UNIQUE` constraint in `server/db/schema.ts`                                                     |
| 2   | `repo_path` immutable after create         | `updateSchedule()` only patches cron/enabled/config                                              |
| 3   | Cron timezone = UTC                        | `server/schedules/cron.ts` hardcodes `timezone: 'UTC'`                                           |
| 4   | Model = harness default                    | `runSessionVertical` never receives `model`; task-backed kinds never stamp `tasks.model`         |
| 5   | Headless session timeout = 5 min           | `DEFAULT_TIMEOUT_MS = 300_000` in `server/agent-session/session.ts`                              |
| 6   | Prompt is per-kind only                    | `resolveSchedulePrompt()` ignores `scheduleId`; the `schedules.prompt` column exists but is dead |
| 7   | `{{placeholder}}` sets                     | hand-written `.replace()` chains in each workflow `run.ts`                                       |
| 8   | `baseBranch: 'main'`, branch name prefixes | `doc-drift/run.ts`, `prod-log-triage/run.ts`                                                     |
| 9   | The set of kinds                           | code registry — a new kind requires a deploy                                                     |

This spec makes 1–8 data (editable from the `/schedules` UI) and adds a generic
**custom** kind as the UI-side answer to 9.

## 1. Goals / non-goals

**Goals**

- Every per-schedule knob editable from the UI: name, repo, cron, timezone, enabled,
  model, session timeout, kind config, and a per-schedule prompt override.
- Multiple independently-configured schedules of the same kind against the same repo.
- Generic `{{key}}` interpolation so skill-body edits and config fields compose without
  code changes.
- A `custom` kind: cron + prompt + generic result envelope, no code registration.

**Non-goals**

- Authoring new _structured_ workflow kinds (bespoke output schemas, feed cards,
  task-backed loops) from the UI. That stays code.
- Per-schedule harness/substrate selection (stays default harness + pty).
- Changing the poller cadence or cron grammar (5-field, minute granularity).
- Seconds-level scheduling, catch-up/backfill for missed windows. (DST fall-back
  double-fire is handled — see §3.)

**Scope adjudications from review** (recorded so implementation doesn't relitigate):

- `repoPath` stays PATCHable (explicit user requirement; cheap for a single-user tool).
- `branchPrefix` stays (schema-driven cost is one property + one template string), with
  refname validation (§6).
- `name` is optional for built-in kinds, **required for `custom`** (custom cards are
  otherwise indistinguishable).
- Kind capability flags stay API-driven (§8) — the client must not hardcode kind lists;
  that's the anti-pattern this spec exists to remove.
- Cut: nothing user-visible. All items from the original audit ship.

## 2. Data model

### 2.1 `schedules` table

Final shape (this exact DDL replaces the current `CREATE TABLE schedules` in
`server/db/schema.ts` — **the SCHEMA constant must be updated in the same change**,
or fresh installs/`createTestDb()` re-create the UNIQUE constraint and silently
re-break multi-instance):

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  name          TEXT,                -- NEW: display name; NULL → kind displayName
  cron          TEXT NOT NULL,
  timezone      TEXT,                -- NEW: IANA zone; NULL → 'UTC'
  enabled       INTEGER NOT NULL DEFAULT 1,
  model         TEXT,                -- NEW: harness model id; NULL → harness default
  timeout_ms    INTEGER,             -- NEW: headless session timeout; NULL → 300000
  last_run_at   TEXT,
  config_json   TEXT,
  prompt        TEXT,                -- EXISTING dead column, now live: per-schedule prompt override
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- No UNIQUE(kind, repo_path). No secondary indexes needed today; add here if query
-- patterns change (the dropped UNIQUE index was never used for lookups the poller does).
```

Migration (forward-only, in `server/db/migrations.ts`):

- **Idempotency guard**: run the rebuild only when
  `!columnsOf(instance, 'schedules').has('timezone')`. (The existing `addColumn` guards
  for `config_json`/`prompt` at migrations.ts:908–910 run _before_ this block and stay.)
- **Transaction-wrapped**, matching `rebuildAgentsTable` and the `permission_prompts`
  rebuild: `CREATE TABLE schedules_new (…) → INSERT INTO schedules_new (id, kind,
repo_path, cron, enabled, last_run_at, config_json, prompt, created_at, updated_at)
SELECT … FROM schedules → DROP TABLE schedules → ALTER TABLE schedules_new RENAME TO
schedules`. A crash mid-rebuild must not lose the table.
- `name`, `timezone`, `model`, `timeout_ms` are deliberately absent from the
  INSERT/SELECT — they default to NULL for all migrated rows, which reproduces today's
  behavior exactly (§11).
- No FK constraints reference `schedules` (`runs.schedule_id` / `tasks.schedule_id` are
  plain TEXT); row ids and `last_run_at` are preserved, so runs history and the live
  prod schedules survive untouched.

### 2.2 Repository layer (`server/repositories/schedules.ts`)

- `upsertSchedule()` is **deleted**, replaced by `createSchedule()`: pure insert.
  - The post-insert SELECT must switch to `WHERE id = ?` (the fresh nanoid). The current
    `WHERE kind = ? AND repo_path = ?` lookup is only valid under the UNIQUE constraint;
    after the drop it can return the wrong row.
  - `ON CONFLICT(kind, repo_path)` must not appear in any query after the migration
    (undefined without the constraint). Verified callers at time of writing: only
    `routes/schedules.ts`. If a `schedule create` CLI command is added later it must use
    pure-insert semantics.
- `updateSchedule()` accepts the full patchable set: `name`, `repoPath`, `cron`,
  `timezone`, `enabled`, `model`, `timeoutMs`, `config`, `prompt`. `kind` is immutable
  (delete + recreate — a kind change invalidates config/prompt anyway).
- `ScheduleRow` gains `name`, `timezone`, `model`, `timeout_ms`, `prompt` — **and
  `SCHEDULE_COLUMNS` must list them**, or every read silently returns `undefined` for
  the new fields even after the migration.

## 3. Cron evaluation with timezone

`isCronDue(expr, now, timezone?)` in `server/schedules/cron.ts`:

- `timezone ?? 'UTC'` passed to croner (native support).
- The module-level `cache: Map<string, Cron>` key changes from bare `expr` to
  `` `${timezone ?? 'UTC'}\n${expr}` `` **atomically with the signature change** (the
  map is in-memory; no entry migration needed — old-format keys are simply never hit
  again). `\n` cannot collide: croner rejects expressions containing newlines, and
  timezone is validated at write time. Entries are not evicted on schedule
  update/delete — orphaned entries are unreachable and bounded by distinct (tz, expr)
  pairs ever seen; acceptable at this scale (revisit with an LRU if schedule counts
  reach hundreds).
- `pollSchedules()` (server/poller/schedule-cron.ts) changes to
  `isCronDue(row.cron, now, row.timezone)`. Audit test call sites for the new argument.
- **Same-minute refire guard**: skip a row when `last_run_at` falls in the same UTC
  minute as `now`. This closes both the poller-tick-jitter double-fire and the DST
  fall-back double-fire (one UTC minute matching twice), which matters for task-backed
  kinds (two tasks in one minute) and is harmless-but-noisy for digests.
- **Write-time validation** (both `POST` and `PATCH` — note neither currently validates
  cron beyond non-empty): construct `new Cron(expr, { timezone, paused: true })` in a
  try/catch and rethrow as `badRequest` 400 saying whether the expression or the
  timezone is invalid. Never let croner's throw escape as a 500. Runtime behavior for
  a row that somehow holds bad data stays "never matches".

## 4. Prompt resolution & generic interpolation

### 4.1 Resolution precedence

`resolveSchedulePrompt({ scheduleId, kind })` (server/schedule-prompt.ts) becomes:

1. `schedules.prompt` for `scheduleId` — if non-empty, use it.
2. `schedule_skills[kind]` — lazily seeded from shipped SKILL.md (unchanged).

All call sites already pass `scheduleId` (the parameter exists and is currently
ignored) — only the function body changes; no call-site updates needed.

`skillContentOverridesForScheduleId()` (server/schedule-prompt.ts:66, used by all five
task-lifecycle entry points for doc-drift / prod-log-triage) currently calls
`resolveScheduleSkillContent(schedule.kind)` unconditionally and never reads
`schedule.prompt`. **Rewrite its body**: if `schedule.prompt` is non-empty, return
`{ [schedule.kind]: schedule.prompt }`; otherwise fall back to
`resolveScheduleSkillContent(schedule.kind)` as today. Log the branch taken
(`prompt_source: 'schedule_override' | 'kind_skill'`) at debug level in both functions.

New endpoint `GET /api/schedules/:id/effective-prompt` returns
`{ content: string, source: 'override' | 'kind_skill' }` from `resolveSchedulePrompt` —
the UI preview shows exactly what the runtime resolves, with zero client-side
duplication of resolution or interpolation logic.

### 4.2 Interpolation

New `interpolatePrompt(body: string, vars: Record<string, unknown>): string`:

- Replaces every `{{key}}` where `key` is a var; scalars via `String(v)`,
  objects/arrays via `JSON.stringify`.
- **Exactly one pass** — a single sweep; the output is never re-scanned. A var value
  containing `{{otherKey}}` stays literal in the output (test-matrix case). No loops,
  no recursion.
- Unknown placeholders are left intact (visible signal, not silent deletion).
- Var set = resolved schedule config (post-defaults) **plus** workflow-declared extras
  (e.g. slack-watcher's `previousItems`). The hand-written `.replace()` chains are
  deleted. Behavior-preserving: current placeholder names equal the config keys.
- **Scope**: applies to session-vertical kinds and `custom` only. Task-backed kinds'
  prompts are code-built (`buildDocDriftPrompt` / `buildTriagePrompt`); their skill
  bodies reach the agent via the overlay plugin (§4.1) uninterpolated, as today.
- Design note (accepted): config values are injected verbatim into agent prompts. That
  is the existing posture for `previousItems` (raw Slack content) and is the user's own
  configuration in a single-user tool; interpolation does not widen it.

**Multi-instance dedup fix**: `previousItemsJson()` in slack-watcher currently reads the
latest done run for the _kind_, globally. With multiple watcher schedules allowed, it
must become `previousItemsJson(scheduleId)` filtering `runs.schedule_id` (use
`listRunsForSchedule`), or two watchers cross-contaminate each other's dedup memory.

## 5. Model & timeout threading

`RunContext` (server/workflows/types.ts) gains `model?: string | null` and
`timeoutMs?: number | null`, populated by `executeScheduleRun` from the row.

Full threading path (each layer is a real code change — missing any one silently falls
back to defaults with no error):

1. `ScheduleRow` + `SCHEDULE_COLUMNS` (§2.2).
2. `executeScheduleRun` reads `row.model` / `row.timeout_ms` into `RunContext`, and
   logs run start: `logger.info({ schedule_id, kind, trigger, model: row.model ??
'default', timeout_ms: row.timeout_ms ?? 300000, prompt_source }, 'schedule run
started')` — today nothing is logged on success.
3. Each workflow's `run(ctx)` in `*/index.ts` threads `ctx.model` / `ctx.timeoutMs`
   into its service-layer input struct. Structs needing new optional fields:
   `RunSlackWatcherInput`, `RunWeeklyUpdateInput`, `RunOvernightLogSummaryInput`
   (model + timeoutMs); `CreateDocDriftTaskFromScheduleInput`,
   `CreateTriageTaskFromScheduleInput` (model only); `RunDailyPlanFromScheduleInput`
   (model only).
4. Sinks:
   - **Session verticals** (slack-watcher, weekly-update, overnight-log-summary,
     custom): `runSessionVertical` already accepts `model`; add `timeoutMs`, forwarded
     to `runAgentSession` (`timeoutMs ?? DEFAULT_TIMEOUT_MS`).
   - **Task-backed**: stamp the task row's `model` on insert (`tasks.model` +
     `applyModel()` plumbing already exist end-to-end). `timeout_ms` does not apply to
     loop tasks; the UI hides the field (§8 capability flags).
   - **daily-plan**: `CreateChatOptions` gains `model?: string | null`; `createChat`
     applies it via `applyModel(flags, model)` (it currently has no model path at all).
     `timeout_ms` N/A.

**Validation & quoting (security-critical)**: the session-vertical launch string is
executed via `sh -c`, and `applyModel` (server/harnesses/shared.ts:25) appends
`--model ${model}` **unquoted** — a model value with shell metacharacters would execute.
Two independent fixes, both required:

- Write-time: `POST`/`PATCH` reject `model` not matching `^[a-zA-Z0-9._:/-]{1,128}$`.
- Defense-in-depth: `applyModel` wraps the value with `shellQuoteSingle`
  (server/shell-quote.ts) regardless of source.

`timeoutMs` validation: positive integer, `10_000 ≤ v ≤ 86_400_000` (10 s–24 h); 400
outside the range. (Node `setTimeout` misbehaves at 0/negative/`>2^31-1`.) NULL/omitted
→ `DEFAULT_TIMEOUT_MS`.

UI: model is a free-text input with a datalist from a small client constant
(`KNOWN_MODELS` in `src/lib/models.ts` — no model picker exists anywhere in the UI
today, so this is new); empty = harness default. Timeout renders in minutes, stored
as ms.

## 6. Task-backed config additions

`DOC_DRIFT_CONFIG_SCHEMA` and `PROD_LOG_TRIAGE_CONFIG_SCHEMA` gain:

- `baseBranch` (string, default `'main'`) → replaces hardcoded `baseBranch: 'main'`.
- `branchPrefix` (string, defaults `'doc-drift'` / `'triage'`) → branch becomes
  `` `${branchPrefix}/${short}-${dateStamp}` ``.
- Both carry `"format": "single-line"` in their JSON Schema; `SchemaConfigForm` renders
  `format === 'single-line'` strings as `<Input>` instead of the 4-row `<Textarea>`
  (replacing the current hardcoded `verify`/`logCommand` property-name checks with a
  generic mechanism).
- Write-time validation: both must match `^[a-zA-Z0-9._/-]{1,80}$` (git-refname-safe
  subset). Branch strings flow into `execFile('git', …)` — no shell risk — but an
  invalid refname fails task setup late and confusingly; reject early with a 400.

Task title/description templates stay code (cosmetic; not worth config surface).

daily-plan and weekly-update deliberately get **no** kind config: their tunables are the
prompt body (per-kind or per-schedule) plus the new first-class fields.

## 7. The `custom` kind

A registered workflow (`server/workflows/custom/`) whose behavior is entirely data:

- `kind: 'custom'`, `displayName: 'Custom Prompt'`, `surfaces: ['artifact']`,
  `trigger: { kind: 'cron' }` — registering with a cron trigger + `run` handler makes it
  appear in `listCronWorkflowKinds()` automatically, so `assertCronKind` accepts it with
  no route changes.
- **Prompt**: `schedules.prompt`, required — `POST`/`PATCH` reject an enabled custom
  schedule with an empty prompt. Not in `CRON_PROMPT_KINDS` (no SKILL.md seed, nothing
  in Settings → Schedule skills); its `run()` reads the schedule row's prompt directly
  and never calls `resolveScheduleSkillContent` (which would throw for an unseeded kind).
- **Name**: required for custom (§1 adjudication) — cards would otherwise be
  indistinguishable.
- **Config**: none in v1. `{{...}}` interpolation still runs (extras only).
- **Output**: the universal envelope (`RUN_RESULT_SCHEMA` from `@octomux/types`:
  outcome/summary/links) as its full output schema — renders with the generic
  runs-feed card, no new UI.
- **Run lifecycle**: the custom kind's run wrapper owns its `runs` row — `insertRun` on
  entry, `finishRun(status: 'failed')` in its catch — rather than trusting the prompt to
  reach `submit_result`. (Session verticals get this from `runAgentSession`'s existing
  run handling; the wrapper must not leave a row stuck at `running`.)
- **Run**: `runSessionVertical` in `repo_path` with the schedule's model/timeout.

Multiple custom schedules per repo are the point — this is why §2 drops the UNIQUE
constraint rather than special-casing.

## 8. API surface

- `GET /api/schedules/kinds` — each kind gains capability flags so the client renders
  correctly **without hardcoding kind lists**: `promptRequired: boolean` (true for
  custom) and `supportsTimeout: boolean` (true for session-vertical kinds; false for
  task-backed + daily-plan). Derive server-side from a new
  `execution: 'session' | 'task' | 'chat'` field on `WorkflowType` — each workflow
  already knows its nature; the route computes the flags.
- `POST /api/schedules` — always creates (201). New optional fields: `name`, `timezone`,
  `model`, `timeoutMs`, `prompt`. Validation: cron+timezone (§3), config vs kind schema
  (existing), model regex + timeout bounds (§5), refname fields (§6), prompt + name
  presence for custom (§7).
- `PATCH /api/schedules/:id` — accepts the same fields plus `repoPath`. Same validation
  (including the cron-syntax check `PATCH` never had).
- `GET /api/schedules` — returns the new columns.
- `GET /api/schedules/:id/effective-prompt` — §4.1.
- No changes to `/api/schedule-skills` (per-kind default bodies).

**Back-compat**: POST loses upsert-on-conflict semantics. No CLI/plugin callers at time
of writing (verified); any future `schedule create` CLI command uses pure-insert.
Existing rows migrate with all new columns NULL → behavior identical to today.

## 9. UI (`/schedules`)

Create stays the existing **inline panel** (there is no create dialog today — the spec
deliberately keeps the pattern); edit stays expand-in-place on the card.

**Field visibility matrix (create panel):**

| Field                                | Visibility                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kind, repo, cron + timezone, enabled | always                                                                                                                                                                                    |
| name                                 | always for custom (required); for built-ins inside "Advanced" (optional)                                                                                                                  |
| model, timeout                       | "Advanced" disclosure, collapsed by default; timeout only when `supportsTimeout`                                                                                                          |
| config form                          | when the kind has a config schema (existing behavior)                                                                                                                                     |
| prompt                               | custom: always visible, required, submit disabled + required indicator while empty (extends the existing `canSubmit` pattern); other kinds: hidden behind an "Override prompt" disclosure |

**Timezone field**: a searchable combobox (not a native select — `Intl.supportedValuesOf('timeZone')`
returns ~400 entries), filter-on-type, placeholder "UTC" (the stored NULL), plus a
"Use browser timezone" action that fills `Intl.DateTimeFormat().resolvedOptions().timeZone`.
Options display as `Zone/Name (UTC±H:MM)` resolved at the current instant.

**Prompt override editor (edit card)**: collapsed by default. When no override exists it
shows a read-only, code-font preview fetched lazily from
`GET /api/schedules/:id/effective-prompt`; `{{tokens}}` are shown raw with a hint that
they're replaced at runtime by same-named config values. "Override" copies the kind
default into an editable textarea (no blank-canvas start); "Reset to kind default" sets
`prompt = NULL` behind a confirm when the override is non-empty. No staleness indicator
in v1 (override > kind precedence is documented behavior).

**Multi-instance disambiguation**: cards show `name ?? displayName` + kind badge; when
two unnamed rows share `(kind, repo_path)`, append the cron expression in monospace as
the disambiguator. The delete confirm shows `name ?? kind` **plus cron**, never just
`kind · repo_path` (which is now ambiguous). Kind renders as a non-interactive badge in
the edit card (immutable — delete + recreate).

**Client changes checklist** (must land atomically with the server changes — the SPA
treats all new fields as nullable on read for forward-compat): `ScheduleRow`
(+name/timezone/model/timeout_ms/prompt), `ScheduleKindInfo` (+promptRequired/
supportsTimeout/execution), `CreateScheduleInput` / `UpdateScheduleInput` (+ all new
fields, `repoPath` on update), `schedulesApi` (+effective-prompt fetch), `ScheduleForm`
and `ScheduleDetail` state + fields, `SchemaConfigForm` (`format: 'single-line'` →
`<Input>`), new timezone combobox component, `KNOWN_MODELS` constant.

## 10. Testing

Per repo conventions (vitest, `createTestDb()`, supertest against `createApp()`,
table-driven `it.each`):

- Migration: pre-migration rows survive the rebuild (ids, last_run_at intact); two
  same-kind/same-repo inserts succeed post-migration; **migration is idempotent across
  restarts** (guard on existing `timezone` column).
- `isCronDue`: timezone cases (offset zones, DST spring/fall boundaries, invalid zone →
  false), compound cache keying (same expr, two zones → independent matches),
  same-minute refire guard.
- `interpolatePrompt` table: scalars, objects, unknown placeholders untouched, repeated
  keys, **single-pass** (`vars.a = '{{b}}'` stays literal).
- Prompt precedence: override > kind skill > lazy seed; `skillContentOverridesForScheduleId`
  honors the override; effective-prompt endpoint reports source.
- slack-watcher dedup: two schedules of the same kind each see only their own previous
  items (`previousItemsJson(scheduleId)`).
- Route validation table: bad cron 400, bad timezone 400, model regex 400, timeout
  bounds 400, refname fields 400, custom without prompt/name 400, PATCH repoPath.
- Threading: session vertical receives row model/timeout; doc-drift/triage task insert
  stamps `tasks.model`; `applyModel` output is shell-quoted.
- Custom kind: run row created on entry, finishes `failed` on crash (never stuck at
  `running`).
- Component tests for new form fields; **mock `Intl.supportedValuesOf` (undefined in
  JSDOM)**.

## 11. Rollout

Single release; forward-only migration — back up `~/.octomux/data/tasks.db` first (repo
policy). The `SCHEMA` constant, migration, API, and client types all ship in one change
(§2.1, §9). The live instance's existing schedules keep firing identically: all new
columns NULL = today's behavior, row ids and runs history preserved, and the
slack-watcher `.replace()` chain deletion is behavior-preserving because the config keys
equal the current placeholder names. The one intentional behavior change to watch on the
live box: the same-minute refire guard (§3) — strictly a de-duplication, never a missed
scheduled minute.
