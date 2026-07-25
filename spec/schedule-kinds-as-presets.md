# Schedule Kinds as Presets

Status: DRAFT
Date: 2026-07-25
Supersedes parts of `spec/schedule-configurability.md` (§4.1 prompt precedence, §7 custom kind)

## 0. Problem

`spec/schedule-configurability.md` made every per-schedule knob editable, but left the
prompt body in a second storage system: the `schedule_skills` table, lazily seeded from
the shipped `SKILL.md`, resolved at run time through a precedence chain
(`schedules.prompt` → `schedule_skills[kind]` → `SKILL.md`), and then written back out to
disk as an ephemeral overlay plugin so the harness can read it as a file again.

**This has already failed in production.** All six `schedule_skills` rows in the live DB
differ from their shipped `SKILL.md`, with no user edits to explain it — the seed fired
once and the repo files moved on. Diffing `weekly-update`:

```
1a2
> name: weekly-update      ← added to the repo file after the DB seeded
68d68
< (trailing blank line)
```

The stale DB copy is the one that runs. A cache with no invalidation, holding nothing the
files don't, silently shadowing the source of truth.

Separately, the set of kinds is code-only: a new kind requires a deploy (audit item #9,
never closed — the `custom` kind was the workaround).

## 1. Model

Two ideas, cleanly separated:

- **A kind is a preset.** A JSON file holding display metadata, a default cron, a prompt
  body, and optional config/output JSON Schemas. It is read **only when the UI builds a
  create form**. It is not a runtime dependency.
- **A schedule row is self-contained.** Prompt, config, model, timeout, cron, timezone —
  all materialized at create time by copying from the preset. `executeScheduleRun` reads
  the row and nothing else.

Consequence: **no resolution, no precedence, no lazy seeding, no per-kind DB table.**

### 1.1 Goals / non-goals

**Goals**

- Delete the `schedule_skills` table and the prompt-resolution chain.
- Kinds become data: shipped presets plus user-authored presets, no deploy needed.
- Kinds and schedules are both shareable as JSON — export from the UI, import elsewhere.
- Authoring a new session kind (prompt + config schema + output schema) is possible
  entirely from the UI, reusing the two renderers that are already schema-driven.

**Non-goals**

- User-authored `task`- or `chat`-execution kinds. Those need real task-lifecycle wiring;
  home-tier presets are forced to `session` (§3.3).
- A graphical JSON Schema builder. The kind editor takes raw JSON in a validated textarea.
- Retroactive preset application. Editing a preset never touches existing schedules (§7.1).
- A kind registry, marketplace, or install-from-URL. Sharing is a JSON file.

## 2. Preset format

```json
{
  "kind": "weekly-update",
  "displayName": "Weekly Update",
  "execution": "session",
  "defaultCron": "0 9 * * 1",
  "prompt": "...",
  "config": { "type": "object", "properties": { ... } },
  "output": { "type": "object", "properties": { ... } }
}
```

| Field         | Required | Notes                                                                            |
| ------------- | -------- | -------------------------------------------------------------------------------- |
| `kind`        | yes      | `^[a-z0-9][a-z0-9-]*$`; must equal the filename stem                             |
| `displayName` | yes      | Shown on cards and in the kind picker                                            |
| `execution`   | yes      | `session` \| `task` \| `chat`. Home tier: `session` only (§3.3)                  |
| `defaultCron` | no       | Pre-fills the create form. Absent → form starts on the `daily` preset            |
| `prompt`      | no       | Copied into `schedules.prompt` at create time. Absent → blank (the old `custom`) |
| `config`      | no       | JSON Schema; renders via the existing `SchemaConfigForm`                         |
| `output`      | no       | JSON Schema; renders via the existing `DefaultDetailView`                        |

Presets are the **complete** list of cron-schedulable kinds. Non-cron workflows
(`reviewer`, `pr-extract`, `loops` — github/manual triggers) have no preset and stay pure
code, exactly as today.

## 3. Loader

### 3.1 Tiers

| Tier     | Path                         | Writable |
| -------- | ---------------------------- | -------- |
| Built-in | `<octomux-pkg>/kinds/*.json` | no       |
| Home     | `~/.octomux/kinds/*.json`    | yes (UI) |

Home wins on `kind` collision, so a user can override a shipped preset by name. Add
`kinds/` to `package.json#files`. New helpers in `server/octomux-paths.ts`:
`builtInKindsDir()`, `homeKindsDir()` (the latter mirroring `homeAgentsDir()`'s
`OCTOMUX_KINDS_DIR` override for tests).

There is deliberately **no repo tier**. Kinds are global; a schedule's repo is a property
of the schedule, not of the kind.

### 3.2 Load-time validation

Presets load once at boot into an in-memory map (they change only via the UI, which
reloads the map on write). A file that fails validation is **skipped with a
`logger.warn`, never a boot crash** — a hand-edited file in `~/.octomux/kinds/` must not
take the server down. Rejections:

- unparseable JSON, or missing/mismatched `kind`, or missing `displayName`/`execution`
- `config` / `output` that are not valid JSON Schema (compile with the existing ajv
  instance from `workflows/config.ts`; its `single-line` format registration applies)
- `defaultCron` that croner rejects (reuse `validateCronWithTimezone`)
- `execution` of `task`/`chat` with no code handler registered for that kind

### 3.3 Home-tier presets are `session`-only

A home-tier preset declaring `task` or `chat` is rejected at load. This closes the
"user-authored kind names a handler that doesn't exist" hole with one rule instead of
per-field validation, and matches the non-goal in §1.1.

### 3.4 Merge with code handlers

`registerWorkflow()` keeps registering execution handlers. At boot, presets merge with
registered handlers to produce the effective workflow map — `getWorkflow(kind)` keeps its
current signature and return shape, so route and poller call sites are unchanged.

- `execution: 'session'` → the generic session runner (§4.2)
- `execution: 'task' | 'chat'` → the code handler registered under that kind

`listCronWorkflowKinds()` becomes "kinds that have a preset".

## 4. Code changes

### 4.1 Deletions

| What                                                                                                                                                                                                     | Approx. |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `schedule_skills` table, `repositories/schedule-skills.ts`, `routes/schedule-skills.ts`                                                                                                                  | 120     |
| Settings → "Schedule skills" section (`SettingsPage.tsx:840–940`) and `scheduleSkillsApi`                                                                                                                | 100     |
| `schedule-prompt.ts`: `CRON_PROMPT_KINDS`, `TASK_BACKED_KINDS`, `isCronPromptKind`, `getDefaultPromptForKind`, `resolveScheduleSkillContent`, `resolveSchedulePrompt`, `resolveSchedulePromptWithSource` | 110     |
| `GET /api/schedules/:id/effective-prompt` and `PromptOverrideEditor`'s fetch/preview/reset machinery                                                                                                     | 90      |
| `resolveWorkflowConfig`'s read-time ajv defaults                                                                                                                                                         | 15      |
| `workflows/weekly-update/run.ts`, `workflows/overnight-log-summary/run.ts`, `workflows/custom/`                                                                                                          | 170     |
| `plugin/skills/{doc-drift,prod-log-triage,weekly-update,overnight-log-summary,daily-plan,slack-watcher}/`                                                                                                | 6 dirs  |

The six `SKILL.md` files are referenced by name **only** in `schedule-prompt.ts`
(verified by grep across `server/` and `cli/`). Deleting them removes
`/octomux:doc-drift` and friends as manual Claude Code slash-commands; the other 16
skills in `plugin/skills/` are untouched. Their prompt text moves verbatim into the
corresponding `kinds/*.json`.

This also subsumes the `CRON_PROMPT_KINDS` / `TASK_BACKED_KINDS` cleanup tracked
separately — no dedicated task needed.

### 4.2 Survivals

- **`skillContentOverridesForScheduleId`** (5 call sites in `task-engine/lifecycle/`)
  collapses to no branches:

  ```ts
  const schedule = scheduleId ? getSchedule(scheduleId) : null;
  return schedule?.prompt ? { [schedule.kind]: schedule.prompt } : undefined;
  ```

  It stays because it is how task-backed kinds hand the prompt to the agent.

- **`writeOverlayPlugin`** (`octomux-plugin.ts`) stays. It is already ephemeral and now
  has exactly one input. With the six `SKILL.md` files gone it is no longer an _override_ —
  it is the only delivery path for task-backed prompts.

- **`interpolatePrompt`** stays. Injecting `{{configKey}}` at run time is templating, not
  fallback.

- **The generic session runner**: today's `workflows/custom/run.ts` (78 lines) already is
  it. Move to `workflows/session-runner.ts` and point `weekly-update`,
  `overnight-log-summary`, and every home-tier preset at it. `slack-watcher` keeps its
  own `run.ts` for the `previousItems` dedup extras.

### 4.3 Config defaults move to write time

`POST`/`PATCH /api/schedules` applies ajv `useDefaults` against the kind's `config` schema
**before** storing, so `config_json` is always fully materialized. `resolveWorkflowConfig`
becomes `JSON.parse(row.config_json ?? '{}')`.

At boot, validate each stored `config_json` against its kind's current schema and
`logger.warn` on mismatch. **Log only — never rewrite a stored row** (§7.2).

## 5. API

| Endpoint                                  | Change                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/schedules/kinds`                | Served from presets. `promptRequired` = preset has no `prompt`; `supportsTimeout` = `execution === 'session'`. Both stay derived — no client-side kind lists. |
| `GET /api/schedules/:id/effective-prompt` | **Deleted.** The row _is_ the prompt.                                                                                                                         |
| `GET /api/schedules/:id/export`           | New. Row minus `id`, `repo_path`, `last_run_at`, timestamps.                                                                                                  |
| `POST /api/schedules/import`              | New. Body = export envelope + `repoPath`. Reuses the `POST` validation path verbatim.                                                                         |
| `GET /api/kinds`                          | New. All presets + a `source: 'builtin' \| 'home'` field.                                                                                                     |
| `PUT /api/kinds/:kind`                    | New. Validates (§3.2) and writes `~/.octomux/kinds/<kind>.json`, then reloads the map.                                                                        |
| `DELETE /api/kinds/:kind`                 | New. Home tier only; 400 on a built-in. Removing a home override reveals the built-in again.                                                                  |
| `/api/schedule-skills` (3 routes)         | **Deleted.**                                                                                                                                                  |

Export envelopes carry `"octomuxSchedule": 1` / `"octomuxKind": 1` so import can reject
foreign JSON with a clear message rather than a schema error.

Path safety on `PUT`/`DELETE /api/kinds/:kind`: validate `kind` against
`^[a-z0-9][a-z0-9-]*$` **before** joining it to `homeKindsDir()`. Reuse the `saved-files`
validator rather than writing a second one.

## 6. UI

### 6.1 Settings → Kinds (new section)

Replaces the deleted "Schedule skills" section in the same slot.

- List of presets with a `built-in` / `custom` badge.
- **New kind** — opens the editor blank.
- **Edit** — home-tier presets edit in place. A built-in offers **Copy to custom**, which
  clones it to the home tier under a new `kind` id and opens that for editing.
- **Delete** — home tier only.
- **Export** (copy JSON / download) and **Import JSON** on the section header.

Editor fields: `kind`, `displayName`, `defaultCron` (reusing `CronPresetField`), `prompt`
(textarea), `config` and `output` as **raw JSON textareas** validated on blur with inline
errors. No schema-builder UI — the two schemas are written by hand or pasted, and both
render immediately in the create form and runs feed because those renderers are already
generic.

### 6.2 `/schedules`

- `PromptOverrideEditor` becomes a plain textarea bound to `schedules.prompt`, pre-filled
  from the preset at create time. No preview fetch, no "reset to kind default", no source
  badge — there is only one prompt now.
- **Export** on each card; **Import JSON** beside the create panel (prompts for the target
  repo, since `repoPath` is not in the envelope).
- Kind picker sources `displayName` and `defaultCron` from the preset.

## 7. Behavior changes to accept

### 7.1 Preset edits do not reach existing schedules

Presets are copied at create time; rows are frozen snapshots. Fixing a bug in a shipped
prompt means re-creating or hand-editing each schedule using it. With 1 schedule in
production today this is free; at ~30 it is worth revisiting. The UI should make the copy
semantics visible — the create form shows the prompt as an editable field pre-filled from
the preset, not as an invisible default.

### 7.2 Config defaults freeze too

Adding a property with a default to a preset's `config` schema will not reach existing
rows: the stored config is missing the key, so the runtime reads `undefined` where it
previously read the default. The boot-time validation in §4.3 surfaces this as a warn.
Auto-rewriting stored rows is explicitly rejected — it would reintroduce exactly the
silent-drift failure this spec exists to remove.

## 8. Migration

Forward-only, transaction-wrapped, guarded on the existence of `schedule_skills`:

1. Backfill `schedules.prompt` from `schedule_skills` for rows where `prompt` is NULL or
   empty, joining on `kind`. If no `schedule_skills` row exists for that kind, fall back to
   the shipped preset's `prompt`. **Production: 1 row (`doc-drift`).**
2. Materialize `config_json` defaults for every existing row against its kind's current
   `config` schema.
3. `DROP TABLE schedule_skills`.

A row whose `kind` has no preset after migration keeps its stored prompt and simply stops
being creatable from the UI; the poller still fires it if a handler exists. Log a warn at
boot.

Back up `~/.octomux/data/tasks.db` first, per repo policy.

## 9. Testing

Per repo conventions (vitest, `createTestDb()`, supertest against `createApp()`,
table-driven `it.each`):

- **Loader**: home overrides built-in; malformed JSON skipped with a warn, not a throw;
  filename/`kind` mismatch rejected; invalid `config` schema rejected; home-tier
  `execution: 'task'` rejected; `task`/`chat` preset with no registered handler rejected.
- **Merge**: `getWorkflow()` returns preset fields + code handler;
  `listCronWorkflowKinds()` equals the preset set; non-cron workflows absent from it.
- **Create**: prompt copied from preset into the row; config defaults materialized on
  write; a later preset edit leaves the existing row untouched (§7.1).
- **Run**: `executeScheduleRun` reads only the row — assert it never touches the preset
  map (spy on the loader).
- **Overlay**: `skillContentOverridesForScheduleId` returns the row prompt for task-backed
  kinds, `undefined` otherwise.
- **Export/import**: round-trip a schedule and a kind; foreign JSON rejected by envelope
  version; kind `PUT` with a traversal-shaped name 400s before touching the filesystem.
- **Migration**: NULL prompt backfilled from `schedule_skills`; falls back to the preset
  when no row exists; config defaults materialized; idempotent across restarts.
- **Component**: kind editor rejects invalid JSON Schema inline; schedules page prompt
  textarea pre-fills from the preset.

## 10. Rollout

Single release. The migration, preset files, loader, API, and client ship together — a
half-applied state has the poller reading a dropped table. The one production schedule
keeps firing with an identical prompt (backfilled from the `schedule_skills` body that is
already what runs today, stale frontmatter and all).

Net: **~600 lines and one table deleted**; one new loader (~80 lines), two new route
groups (~120 lines), one new Settings section (~180 lines).
