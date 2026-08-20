# Plugin Runtime P0 — SHR-253/254/255/256

> Execution plan for the Linear project **Octomux Plugin Runtime**
> (https://linear.app/shreypaharia/project/octomux-plugin-runtime-a23074bc72e9).
> P0 is four Urgent tickets. STEP-0 below pins every contract; the four
> implementation tasks then run in two parallel waves with disjoint file sets.

```
SHR-253 ctx.http.route()  ── blocks ──▶ SHR-254 lifecycle / unmount
SHR-255 ctx.facts ─────────  blocks ──▶ SHR-256 ctx.ui (read)
```

Wave 1 = 253 ∥ 255. Wave 2 = 254 ∥ 256.

---

## Global Constraints

- **bun test, not vitest.** Import from `server/bun-test.ts` (`src/` tests from
  `src/bun-test.ts`). Never from `vitest`.
- **`vi.mock()` does not hoist.** Load the module under test with `await import()`
  after the mocks. Mock factories must be synchronous.
- Run only your own slice: `NODE_ENV=test timeout 120 bun test ./server/<yours> --timeout 15000`.
  Never `bun test <directory>` without `--parallel` — it hangs.
- All server logging through `childLogger('<module>')`. Never `console.*` in `server/`.
- SQL with `datetime('now')` uses template literals (single quotes inside backticks).
- Go through `server/sqlite.ts`, never `bun:sqlite` directly.
- Never derive a disk path from `import.meta.url` — `/$bunfs/root` under `bun --compile`.
- Prettier: single quotes, trailing commas, 100 char width.
- **Do not commit.** The controller commits. Do not run repo-wide `typecheck`.
- **Do not touch any file outside your owned set.** STEP-0 has already written the
  signatures you implement against — fill in bodies, do not change exported shapes.

## Rulings taken before execution

| #   | Decision                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cost if wrong                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| R1  | `ctx.facts` gets its **own `plugin_facts` table**, not the existing `events` table                            | `events` is the orchestrator's control bus: written at `repositories/orchestrator.ts:454`, drained by `SELECT * FROM events WHERE seq > ?` (`:465`) with `managed_tasks.last_event_seq` as cursor, plus a typed read on `task:phase_complete` (`:484`). Sharing it puts plugin facts into the conductor's drain and shares one AUTOINCREMENT seq between control and observation. SHR-255's "largely a matter of exposing it" is wrong. | One extra table + migration. Reversible.                                                 |
| R2  | `ctx.kv` stays as-is (throwing) — P0 does not touch it                                                        | Facts covers most of kv's use. Deciding kv's fate is SHR-263's job, not P0's. Shipping two stores in one release is worse than shipping one and deferring.                                                                                                                                                                                                                                                                              | A plugin wanting plain kv still waits. Unchanged from today.                             |
| R3  | Five registries need deregistration, not four                                                                 | SHR-254 says four. Actual: workflows, integrations, harnesses, **kind presets**, **http routes**.                                                                                                                                                                                                                                                                                                                                       | Missed one → a reload leaks kinds.                                                       |
| R4  | `registerWorkflow` keeps having no duplicate guard; unregister must tolerate `reloadPresets()` re-registering | `presets.ts` deliberately re-registers to overlay preset metadata, and `reloadPresets()` runs on every UI kind write. A guard breaks kind editing (documented in `workflows/registry.ts:10`).                                                                                                                                                                                                                                           | Unregister races preset reload → kind vanishes from the UI.                              |
| R5  | Plugin routes mount under `/api/p/<pluginId>/<path>`                                                          | Namespacing by manifest id matches every other registration. A flat namespace lets two plugins collide.                                                                                                                                                                                                                                                                                                                                 | Path shape is public API; changing it later breaks installed plugins.                    |
| R6  | Agents work **in the shared worktree** with disjoint file sets, not one worktree each                         | `plans/2026-08-16-plugin-ecosystem-tasks.md`'s own retrospective: five agent worktrees produced six independent recoveries of the same branch-base bug. Disjoint file sets make separate worktrees pure overhead.                                                                                                                                                                                                                       | Two agents touch one file → merge garbage. Mitigated by STEP-0 owning every shared file. |
| R7  | `ctx.ui` contributions are served over REST + invalidated over the existing WS channel (`server/events.ts`)   | The client registry `src/workflows/registry.ts` is a compile-time Map filled by bundled `register.tsx`. A plugin binding cannot reach it.                                                                                                                                                                                                                                                                                               | Panels need a page refresh to appear.                                                    |

## Naming

Three different "events" already exist. Keep them distinct:

| Name                               | What                             |
| ---------------------------------- | -------------------------------- |
| `server/events.ts`                 | WebSocket fan-out to the SPA     |
| `events` table                     | orchestrator control bus         |
| `plugin_facts` table / `ctx.facts` | **new** — plugin observation log |

---

## STEP-0 — contract foundation (controller, sequential, DONE before any dispatch)

Owns every file more than one task would otherwise touch:

```
packages/plugin-api/src/index.ts      # ctx.http, ctx.facts, ctx.ui, ctx.effect on PluginContext
server/plugins/context.ts             # wires all four registrars
server/api.ts                         # mounts the two new parent routers
server/plugins/http-registry.ts       # signatures + throwing bodies  (task A fills in)
server/plugins/facts.ts               # signatures + throwing bodies  (task B fills in)
server/plugins/ui-registry.ts         # signatures + throwing bodies  (task D fills in)
```

Every skeleton exports its final signature. Implementation tasks fill bodies and
add tests; **none of them may change an exported shape.**

---

## Task A — SHR-253 `ctx.http.route()`

**Owns:** `server/plugins/http-registry.ts` (+ `.test.ts`),
`server/workflows/pr-extract/index.ts`, `server/workflows/pr-extract/routes.ts`,
`cli/src/commands/doctor.ts`

Replace the Express Router handout with a data registration. Routes become rows in
a table behind one permanently-mounted parent router — removing a plugin deletes
its rows, so nothing needs unmounting.

`server/api.ts:48`'s `for (const wf of listWorkflows()) { if (wf.apiRouter) ... }`
loop is **already replaced by STEP-0** — do not edit `api.ts`.

1. Implement the route table in `http-registry.ts`: `Map<pluginId, Map<'METHOD /path', handler>>`.
2. Dispatch is a table lookup inside the parent router, mounted at `/api/p`. A miss is a 404,
   not a fallthrough.
3. `apiRouter` keeps working, marked `@deprecated`, and sets `unloadable: false`
   for that plugin (task C reads this).
4. Migrate **pr-extract** off `apiRouter` as the proof (smaller than reviewer). Its
   existing paths must keep serving — add compatibility aliases if the new namespace
   would move them.
5. `octomux doctor` prints route count per plugin, read from the persisted load
   report, with no running server.

**Done when:** a fixture plugin's route serves; deregistering removes it with no
restart and no dangling handler; pr-extract's existing endpoints still answer.

## Task B — SHR-255 `ctx.facts`

**Owns:** `server/db/migrations.ts` (append only), `server/repositories/plugin-facts.ts`
(+ `.test.ts`), `server/plugins/facts.ts` (+ `.test.ts`)

A typed, task-scoped, append-only fact log any plugin can write to and read from.

1. Migration: `plugin_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
DEFAULT (datetime('now')))` + index on `(task_id, seq)` and on `(type, seq)`.
   **Append to the existing SCHEMA block. Do not reorder or edit anything already there.**
2. Repository in `repositories/plugin-facts.ts` — insert, read-by-task (optional type
   filter, optional `sinceSeq`), delete-by-task.
3. `facts.ts`: `define` / `put` / `read` / `watch`. Types namespaced via `qualify()` —
   a plugin declares `coverage`, the log stores `coverage-bot:coverage`.
4. ajv validation on write; rejection names the plugin and the failing field.
5. `watch` is an in-process emitter fired on write. **Not** a DB poll.
6. Core publishes `core:diff`, `core:tests.passed`, `core:review.published`,
   `core:pr.opened`. Register these as core-owned types that no plugin can claim.
7. Facts are task-scoped and die with the task — delete on task delete.

**Done when:** two plugins exchange data knowing only a fact type; a plugin's `watch`
fires on a core fact; a schema-violating write is rejected and logged against the
right plugin.

## Task C — SHR-254 lifecycle (wave 2, after A)

**Owns:** `server/plugins/lifecycle.ts` (+ `.test.ts`), `server/workflows/registry.ts`,
`server/harnesses/registry.ts`, `server/integrations/registry.ts`,
`server/workflows/presets.ts`, `server/plugins/loader.ts`, `cli/src/commands/plugins.ts`

Track every registration and reverse it on unmount, in reverse order.

1. Add `unregisterWorkflow` / `unregisterHarness` / `unregisterProvider` /
   `unregisterPluginKinds`. All five registries are plain `Map`s — `delete` is the
   whole implementation. **Respect R4:** unregister must not fight `reloadPresets()`.
2. Per-plugin disposal stack in `lifecycle.ts`. `createPluginContext` already returns
   a context; extend `revokePluginContext` rather than inventing a parallel mechanism.
3. `ctx.effect(fn)` — STEP-0 already wired it to the disposal stack; implement the stack.
4. Unmount calls, in reverse order: `unregisterPluginRoutes` (A),
   `unregisterPluginFacts` (B), `unregisterPluginUi` (D), the four registries, then
   `ctx.effect` callbacks.
5. `octomux plugins reload <id>`. **Build this before the file watcher** — it is the
   testable unit; the watcher is a dev nicety on top.
6. File watcher for local-path manifest rows, dev only (`NODE_ENV !== 'production'`).
7. A plugin declaring `apiRouter` reports `unloadable: false` with the reason and
   requires a restart.

**Done when:** editing a local plugin and saving remounts it; running agents are not
interrupted; the unmount log lists what was released; an `apiRouter` plugin reports
`unloadable: false`.

## Task D — SHR-256 `ctx.ui` read (wave 2, after B)

**Owns:** `server/plugins/ui-registry.ts` (+ `.test.ts`), `server/routes/plugin-ui.ts`
(+ `.test.ts`), `src/workflows/renderers/` (new dir), `src/components/PluginPanels.tsx`,
`src/lib/plugin-ui.ts`

A plugin contributes a _binding_, never code. The client owns every renderer, so no
plugin JavaScript reaches the browser.

1. `ctx.ui.panel({ slot, fact, as, ...props })`. Six slots: `task.panel`, `task.badge`,
   `board.card`, `nav.section`, `run.detail`, `settings.card`.
2. `GET /api/plugin-ui/contributions` returns the bindings. `server/api.ts` already
   mounts this router (STEP-0) — do not edit `api.ts`.
3. Client renderer registry keyed by renderer name. Eight renderers: `stat`, `table`,
   `timeline`, `badge`, `markdown`, `json`, `diff`, `log`. **An unknown renderer
   degrades to `json`, never a blank.**
4. Panels read their data from task B's facts read API.
5. Invalidate over the existing WS channel (`server/events.ts` → `src/lib/event-source.ts`)
   so a mount/unmount updates the UI without a refresh.
6. **No `ctx.ui.component()`, no custom sidebar, no served third-party ESM.** That
   ceiling is the feature.

**Done when:** a plugin publishes a fact and a panel appears with no client build;
removing the plugin removes the panel with no restart.

---

## Integration pass (controller, after each wave)

1. `bun run typecheck` — controller owns any cross-task seam
2. `bun run test`
3. Reconcile `server/registry/route-inventory.test.ts` — it asserts exact bidirectional
   equality, so both A and D collide there and **only** there
4. `bun run lint:fix && bun run format`
