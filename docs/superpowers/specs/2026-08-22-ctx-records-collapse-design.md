# `ctx.records` — collapsing three storage layers into one

**Status:** revised after three independent reviews; awaiting approval
**Date:** 2026-08-22

## Problem

The plugin runtime grew three storage APIs backed by three tables within a few days,
each shipped by a task that could not see the others:

| API                         | table                | columns                                              | lines |
| --------------------------- | -------------------- | ---------------------------------------------------- | ----- |
| `ctx.facts` (SHR-255)       | `plugin_facts`       | seq, task_id, type, payload, created_at              | 195   |
| `ctx.collections` (SHR-275) | `plugin_collections` | collection, key, record, created_at, updated_at      | 203   |
| `ctx.kv` (SHR-263)          | `plugin_kv`          | plugin_id, key, value, owner, created_at, updated_at | 103   |

They are one concept — _a namespaced, timestamped record store_ — under three names,
differing on two axes: **scope** (dies with its task, or outlives it) and **mode**
(append a row, or replace one keyed by id).

`kv` and `collections` are the same table twice: `collection` is already namespaced
`<pluginId>:<name>`, so `plugin_id` is derivable. `kv` is `collections` with the
schema optional and the query dropped.

### The split leaked outward

Because a panel can bind to a fact _or_ a collection, `UiPanelBinding` became a
discriminated union, which made `UiContribution.factType` optional, which broke
`server/surfaces/render.ts` when SHR-267 merged, which was patched with
`if (!c.factType) continue`, which left collection panels rendering nowhere, which
became SHR-279. **SHR-279 exists only because facts and collections are separate.**
The same branch is duplicated client-side in `src/components/PluginPanels.tsx:76`
(`isCollectionBound`) with its own `recordsAsFacts()` adapter.

## Why now

```
plugin_facts        6 rows (development data)
plugin_collections  0 rows
plugin_kv           table not yet created
~/.octomux/octomux.yml   absent — zero third-party plugins installed
```

Nothing outside this repository consumes these APIs. Verified independently during
review, including `plugin-load-report.json` showing `"loaded": []`.

## Design

### The API

```ts
ctx.records.define({
  name: string,                       // bare; host qualifies to <pluginId>:<name>
  schema?: Record<string, unknown>,   // JSON Schema; omit for opaque blobs
  key?: string,                       // record field used as identity (upsert only)
  scope: 'task' | 'durable',
  mode: 'append' | 'upsert',
});

await ctx.records.put(name, record, opts?);   // { taskId } iff scope:'task'
await ctx.records.read(name, opts?);          // task-scoped reads
await ctx.records.query(name, q?);            // QuerySpec; durable reads
ctx.records.watch(qualifiedName, cb);         // returns unsubscribe

ctx.records.begin(name, key, value);          // checkpoints (from kv)
ctx.records.end(name, key);
ctx.records.interrupted(name?);               // omit name = every store this plugin owns
```

`define()` is required and idempotent. Shape is declared once; callers do not repeat
`scope`/`mode`. Passing `taskId` to a durable store, or omitting it for a task-scoped
one, is a validation error naming the plugin and the store.

**Checkpoints take a store argument** (review finding). The old flat `plugin_kv`
namespace had one bucket per plugin, so `begin(key)` was unambiguous. A plugin can
now own several stores, and keying checkpoints per-plugin would let two stores
collide on the same key — a failure mode the old design could not have.

### Definition lifetime follows row lifetime

This is the rule that resolves the `kv` asymmetry without a mode flag.

Today `lifecycle.ts:160` drops fact and collection _definitions_ on unmount, while
`kv.ts:18` says outright that kv has **no unmount hook at all**, deliberately, so a
hot-reloaded plugin finds its in-flight checkpoints on the next `apply()`. A uniform
`unregisterPluginRecords()` would make durable reads throw `"not defined"` in the gap
between unmount and the next `define()` — a regression kv never had.

So: **a definition is dropped on unmount only if its rows are.**

| scope     | rows on unmount   | definition on unmount |
| --------- | ----------------- | --------------------- |
| `task`    | die with the task | dropped               |
| `durable` | outlive unmount   | **retained**          |

A durable store whose rows survive but whose definition vanished would be
unreadable, which is incoherent. This is one rule about lifetime, not a special case
for kv — and it makes kv's documented behaviour fall out rather than be exempted.

### Storage

One table, `plugin_records`:

```sql
CREATE TABLE IF NOT EXISTS plugin_records (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  store      TEXT NOT NULL,            -- qualified <pluginId>:<name>
  task_id    TEXT,                     -- NULL for durable stores
  key        TEXT,                     -- NULL for append stores
  payload    TEXT NOT NULL DEFAULT '{}',
  owner      TEXT,                     -- mount id; checkpoints only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_records_key
  ON plugin_records(store, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plugin_records_task  ON plugin_records(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_plugin_records_store ON plugin_records(store, seq);
```

The partial index scopes uniqueness to upsert rows; append rows (`key IS NULL`) are
excluded, so two appends in one store never collide.

**The upsert DML is load-bearing and must be exactly this:**

```sql
INSERT INTO plugin_records (store, task_id, key, payload)
VALUES (?, ?, ?, ?)
ON CONFLICT(store, key) WHERE key IS NOT NULL
DO UPDATE SET payload = excluded.payload,
              updated_at = datetime('now'),
              owner = NULL;
```

Three details, each from review, each silent-until-runtime if wrong:

1. **`ON CONFLICT`, never `INSERT OR REPLACE`.** REPLACE is delete+insert: it would
   bump `seq` and reset `created_at` on every update, so an upserted row would jump
   to the end of the seq stream that append stores share. Follows the existing
   precedent at `server/repositories/plugin-collections.ts:73`.
2. **The conflict target must repeat the partial index predicate** (`WHERE key IS NOT
NULL`). Omit it and SQLite cannot match the partial index: _"ON CONFLICT clause
   does not match any PRIMARY KEY or UNIQUE constraint"_, at runtime.
3. **`owner = NULL` on update.** `kv.test.ts:65` pins that an ordinary write settles
   an in-flight checkpoint. A `DO UPDATE` that touches only `payload` leaves `owner`
   set, and the key shows as permanently interrupted.

**This table is still not `events`.** Ruling R1 kept plugin facts out of the
orchestrator's control bus so plugin writes would not enter the conductor's drain.
Review confirmed that reading is honest: R1 separates plugin storage from _core's
bus_, and says nothing about the three plugin stores relative to each other. R2 in
the same table explicitly defers kv's fate to a later ticket.

### Task deletion

`hardDeleteTask()` (`server/repositories/tasks.ts:568`) calls `deleteFactsForTask(id)`
— deliberately no FK cascade, explained in the comment above it. **This call site
lives outside `server/plugins/`, one layer from every file this change deletes, and
is easy to miss.** It must be rewired to `plugin_records`. The predicate is already
correct for the merged table: `WHERE task_id = ?` matches only task-scoped rows,
since durable rows have `task_id IS NULL`. Missing this leaks task rows forever.

### UI bindings

The union goes away:

```ts
export interface UiPanelBinding {
  slot: UiSlot;
  record: string; // bare local store name; host qualifies
  as: UiRenderer | string;
  value?: string;
  delta?: string;
  title?: string;
}
```

`registerPluginUiPanel` (`ui-registry.ts:99`) already rejects a binding with neither
or both of `fact`/`collection`, so a store-less contribution never legitimately
exists. `UiContribution.recordStore` therefore becomes non-optional and the
`if (!c.factType) continue` skip is deleted.

### Rendering — two entry points, and that is correct

The first draft claimed this collapses to one walk. **Review showed that is wrong and
the claim is withdrawn.** The two functions differ by _what is being rendered_, not
by binding kind:

- `panelsForTask(kind, taskId)` — every contribution bound to a task-scoped store,
  for one task.
- `panelsForStore(kind, store, q?)` — one store, with a `QuerySpec` window.

`renderCollectionPanels`'s `QuerySpec` exists for a stated reason (`plugin-ui.ts:107`):
_"a 2,000-record board does not need every row in a Slack message."_ A merged
walk-everything call has nowhere to put per-store `limit`/`offset`/`orderBy`, and one
shared window across stores with different schemas is meaningless. Dropping it would
be a real capability loss.

What the collapse deletes here is the **binding-kind branch** in both functions and
its client twin — not the second entry point. Renaming for symmetry is the honest
outcome.

### `watch()` envelope

Facts fire watchers with a full envelope (`facts.ts:131`); collections fire the bare
record (`collections.ts:141`). Unspecified in the first draft. **Decision: always the
full envelope** — `{ seq, store, taskId, key, payload, createdAt, updatedAt }`.
Strictly more information, and uniform across modes. Collection-style watchers change
shape; there are zero external consumers.

### Capabilities

| removed                                      | replaced by      |
| -------------------------------------------- | ---------------- |
| `facts.define`, `collections.define`         | `records.define` |
| `facts.put`, `collections.write`, `kv.write` | `records.write`  |

Reads stay ungated, matching `facts.read` / `artifacts.list` / `catalog.list`.
Removing names is a breaking manifest change — acceptable because no manifest exists,
and the validator already names the unknown capability and lists valid ones.

### Core-owned records

`CORE_FACT_TYPES` (`core:review.published`, `core:policy.decision`) become core-owned
records with identical qualified names, `scope:'task'`, `mode:'append'`. The ~12
non-test `core:` call sites keep their meaning; only the import changes.

## What gets deleted

- `server/plugins/facts.ts`, `collections.ts`, `kv.ts` → one `records.ts`
- `plugin_facts`, `plugin_kv`, `plugin_collections` tables
- `UiFactPanelBinding | UiCollectionPanelBinding` union
- `if (!c.factType) continue` in `server/surfaces/render.ts`
- the binding-kind branch in `render.ts` **and** `src/components/PluginPanels.tsx:76`
  (`isCollectionBound`) with its duplicate `recordsAsFacts()`
- three capability names

## Migration

Migrations run on **every boot**, top-to-bottom, with no version table
(`server/db.ts:79`). The three tables exist only via `CREATE TABLE IF NOT EXISTS`
blocks in `migrations.ts:1275-1332`, not in `schema.ts`. Two consequences:

1. **Delete the three old `CREATE TABLE` blocks**, per this repo's own decommission
   convention (`team_runs`, `review_learnings` — `DROP` with no surviving `CREATE`).
   Keeping them means the tables are recreated and re-dropped on every boot forever.
2. **Guard the copy on existence**, or a fresh database — a new clone, CI,
   `migrations.test.ts`'s `:memory:` run — throws `no such table: plugin_facts`:

```js
if (tableExists(instance, 'plugin_facts')) {
  instance.exec(`INSERT INTO plugin_records (store, task_id, payload, created_at)
                 SELECT type, task_id, payload, created_at FROM plugin_facts`);
  instance.exec(`DROP TABLE plugin_facts`);
}
// same shape for plugin_collections; plugin_kv is genuinely never created
```

With the guard, a fresh DB skips the copy entirely and the migration is forward-only
and self-limiting. Without it, "plugin_kv is simply never created" is true only by
accident of file placement.

No down migration: the project has no rollback mechanism, and inventing one for a
6-row change is the speculative machinery this spec exists to remove.

## Testing

The existing suites are **rewritten against `records`, not replaced** — several are
regression tests for specific shipped bugs that do not read as "core behaviour" to
anyone without the history. Each must survive by name:

| test                                           | what it pins                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facts.test.ts:177`, `collections.test.ts:270` | redefining after unregister validates against the NEW schema — the ajv cache is keyed by qualified name and must be busted on redefine. Exists twice today; needed for every scope/mode combination. |
| `facts.test.ts:206`, `collections.test.ts:248` | reloading the defining plugin does not kill another plugin's watcher — watcher lifetime belongs to the watcher                                                                                       |
| `collections.test.ts:65-129`                   | key validation: invalid `key` config at define time; record missing its key; non-scalar key values rejected; numeric keys stringified                                                                |
| `collections.test.ts:139`                      | a qualified name passed to `put` is an out-of-scope cross-plugin write                                                                                                                               |
| `kv.test.ts:65`                                | a plain write settles an in-flight checkpoint — the `owner = NULL` case above                                                                                                                        |
| `kv.test.ts:64-97`                             | a checkpoint written under one mount id is returned by `interrupted()` under another                                                                                                                 |

New tests:

- writing to a task-scoped store with no `taskId` is rejected naming plugin and
  store; and the reverse for durable
- `mode:'append'` with `key` set, and `mode:'upsert'` without, are both rejected at
  `define()` — today the DDL comment is a convention, not a rule
- two stores owned by one plugin do not collide on a checkpoint key
- an upsert leaves `seq` and `created_at` unchanged

**`portability.test.ts` keeps both `describe` blocks.** The first draft implied one
binding kind means one test path. That is wrong: `panelsForTask` and `panelsForStore`
remain two paths, and the second block is currently the only coverage of the
durable/no-task path _and_ of the SHR-279 regression itself. Collapsing it to one
block would leave a broken durable path passing the whole suite silently — SHR-279's
exact failure mode, one level deeper.

`integration.test.ts:244,333,676-699` hardcodes `grants: [facts.put]` fixtures
including the `acknowledgeGrants` widen flow; these need mechanical renaming, and a
partial rename can leave tests unexercised rather than failing loudly.

## Separately identified, not in this change

Four registries — `compute`, `harnesses`, `surfaces`, `integrations` — are the same
~70-line module four times (`Map<kind,T>`, `frozen` flag, register → freeze-check →
duplicate-check → warn-and-keep-first, reset, unregister-refusing-core), with
copy-pasted log strings differing by one noun. One
`createFrozenKindRegistry<T>(coreKinds)` factory removes ~200 lines with no API
change. `server/workflows/registry.ts` deliberately does not follow this shape —
`presets.ts` re-registers over an existing kind on purpose — and stays out.

Its own change, after this one.

## Explicitly out of scope

Review examined and rejected, with reasons that held up under inspection:

- `ctx.services` → `ctx.catalog` — services holds live impl objects with hot-swap
  resolution; catalog only ever emits `provides: string[]`. Folding makes catalog
  writable, violating its stated "no write path, no override path" rule.
- `ctx.agents.run` → `ctx.fanout.run` — fanout has a DB-backed run/item table, a
  concurrency semaphore and resumability; `agents.run` is one ephemeral subprocess
  with no run id.
- `ctx.attention` → `ctx.ui.action` — attention races every prompt-capable surface
  with a 5-minute timeout; ui.action is one synchronous core route.
- `ctx.http.route` vs `ctx.ui.action`, `ctx.policy` vs `ctx.attention`,
  `ctx.surfaces` vs `ctx.ui`, `ctx.artifacts` vs `ctx.records`, `ctx.settings` vs
  `ctx.kv`, `ctx.catalog` vs `LoadReport` — each examined; all genuinely orthogonal
  on owner, lifetime, or a behavioural difference a plugin author would notice.
