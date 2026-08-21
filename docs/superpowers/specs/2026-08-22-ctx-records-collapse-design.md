# `ctx.records` — collapsing three storage layers into one

**Status:** design, awaiting review
**Date:** 2026-08-22

## Problem

The plugin runtime grew three storage APIs backed by three tables, all within a
few days of each other, each shipped by a task that could not see the others:

| API | table | columns | lines |
| --- | --- | --- | --- |
| `ctx.facts` (SHR-255) | `plugin_facts` | seq, task_id, type, payload, created_at | 195 |
| `ctx.collections` (SHR-275) | `plugin_collections` | collection, key, record, created_at, updated_at | 203 |
| `ctx.kv` (SHR-263) | `plugin_kv` | plugin_id, key, value, owner, created_at, updated_at | 103 |

They are not three concepts. They are one concept — *a namespaced, timestamped
record store* — under three names, differing in exactly two axes:

- **scope**: does a row die with its task, or outlive it?
- **mode**: does a write append a new row, or replace one keyed by id?

`kv` and `collections` are the same table twice. `(plugin_id, key, value)` and
`(collection, key, record)` carry identical information: `collection` is already
namespaced `<pluginId>:<name>`, so `plugin_id` is derivable from it. `kv` is
`collections` with the schema made optional and the query dropped.

### The cost is not just three modules

The split leaked outward. Because a panel can bind to a fact *or* a collection,
`UiPanelBinding` became a discriminated union, which forced `UiContribution.factType`
to be optional, which broke `server/surfaces/render.ts` when SHR-267 merged, which
was patched with `if (!c.factType) continue`, which left collection-bound panels
rendering nowhere, which was filed as SHR-279 and fixed with a *second render entry
point*.

**SHR-279 exists only because facts and collections are separate stores.** Collapse
them and the ticket, the union, the skip, and the second entry point all disappear.

## Why now

Verified against the live installation:

```
plugin_facts        6 rows   (development data)
plugin_collections  0 rows
plugin_kv           table not yet created
~/.octomux/octomux.yml   absent — zero third-party plugins installed
```

Nothing outside this repository consumes these APIs. A rename breaks no one today
and breaks every plugin author later. This is the cheapest this change will ever be.

## Design

### The API

```ts
ctx.records.define({
  name: string,                       // bare; host qualifies to <pluginId>:<name>
  schema?: Record<string, unknown>,   // JSON Schema; omit for opaque blobs
  key?: string,                       // record field used as identity (upsert mode)
  scope: 'task' | 'durable',
  mode: 'append' | 'upsert',
});

await ctx.records.put(name, record, opts?);   // { taskId } required when scope:'task'
await ctx.records.read(name, opts?);          // { taskId } + filters, task-scoped reads
await ctx.records.query(name, q?);            // QuerySpec, durable reads
ctx.records.watch(qualifiedName, cb);         // returns an unsubscribe fn

ctx.records.begin(key, value);                // checkpoints, carried over from kv
ctx.records.end(key);
ctx.records.interrupted();
```

Shape is declared **once** at `define()`. Callers do not repeat `scope`/`mode` on
every write; passing a `taskId` to a durable store, or omitting one for a
task-scoped store, is a validation error naming the plugin and the store.

### Today's three become three configurations

| was | `scope` | `mode` | `schema` |
| --- | --- | --- | --- |
| `ctx.facts` | `task` | `append` | required |
| `ctx.collections` | `durable` | `upsert` | required |
| `ctx.kv` | `durable` | `upsert` | omitted (opaque) |

### Storage

One table, `plugin_records`:

```sql
CREATE TABLE IF NOT EXISTS plugin_records (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  store      TEXT NOT NULL,            -- qualified <pluginId>:<name>
  task_id    TEXT,                     -- NULL for durable stores
  key        TEXT,                     -- NULL for append stores
  payload    TEXT NOT NULL DEFAULT '{}',
  owner      TEXT,                     -- mount id, checkpoints only
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_records_key
  ON plugin_records(store, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plugin_records_task  ON plugin_records(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_plugin_records_store ON plugin_records(store, seq);
```

`seq` keeps append ordering, which `plugin_facts` needed and `plugin_collections`
did not. The partial unique index gives upsert its identity without constraining
append rows, which have no key.

**This table is still not `events`.** Ruling R1 in
`plans/2026-08-20-plugin-runtime-p0.md` kept plugin facts out of the orchestrator's
control bus, because sharing one `AUTOINCREMENT` seq between control events and
observation records would put plugin writes into the conductor's drain. That
reasoning is untouched here — it separated plugin storage from *core's* bus, not
plugin storage from itself.

### UI bindings

`UiPanelBinding` stops being a union:

```ts
export interface UiPanelBinding {
  slot: UiSlot;
  record: string;      // bare local store name; host qualifies
  as: UiRenderer | string;
  value?: string;
  delta?: string;
  title?: string;
}
```

`UiContribution.recordStore` is non-optional, so the render path has nothing to skip.

### Rendering

`renderCollectionPanels()` is deleted. `panelsForSurface(kind, opts)` takes an
optional `taskId`: present, it reads task-scoped stores for that task; absent, it
reads durable ones. One walk, one entry point, and `render` still never branches on
binding kind — records reach it as a uniform array, which is what keeps the
portability property in `server/surfaces/portability.test.ts` true.

### Capabilities

Five collapse to two:

| removed | replaced by |
| --- | --- |
| `facts.define`, `collections.define` | `records.define` |
| `facts.put`, `collections.write`, `kv.write` | `records.write` |

Reads (`read`, `query`, `watch`, `interrupted`) stay ungated, matching
`facts.read` / `artifacts.list` / `catalog.list` precedent.

Removing names from `PLUGIN_CAPABILITIES` is a **breaking manifest change**: a row
declaring `grants: [facts.put]` will fail validation. Acceptable because no manifest
exists. The error already names the unknown capability and lists the valid set.

### Core-owned records

`CORE_FACT_TYPES` (`core:review.published`, `core:policy.decision`) become
core-owned records with the same qualified names, `scope:'task'`, `mode:'append'`.
The ~20 `core:` call sites keep their meaning; only the module they import changes.

## What gets deleted

- `server/plugins/facts.ts`, `collections.ts`, `kv.ts` → one `records.ts`
- `plugin_facts`, `plugin_kv` tables
- `UiFactPanelBinding | UiCollectionPanelBinding` union
- `renderCollectionPanels()` and its route
- `if (!c.factType) continue` in `server/surfaces/render.ts`
- three capability names

## Migration

One forward migration: create `plugin_records`, copy the 6 `plugin_facts` rows
(`store := type`, `task_id := task_id`, `payload := payload`, `key := NULL`), copy
`plugin_collections` (0 rows, kept for correctness not effect), drop both old
tables. `plugin_kv` does not exist in the live database and is created-then-dropped
in the same migration run, so it is simply never created.

No down migration. The project has no rollback mechanism and inventing one for a
zero-row change is the kind of speculative machinery this spec exists to remove.

## Testing

- Existing `facts`/`collections`/`kv` suites are rewritten against `records`, not
  deleted — they encode real behaviour (namespacing, schema rejection, unmount
  semantics, checkpoint recovery).
- `portability.test.ts` keeps its property and loses its duplication: one
  binding kind, so the "registered before the surface existed" test covers
  everything rather than needing a variant per store.
- New: writing to a task-scoped store without a `taskId` is rejected, naming the
  plugin and the store; and the reverse.
- New: a checkpoint written under one mount id is returned by `interrupted()` under
  another, which is SHR-263's crash-recovery property surviving the move.

## Explicitly out of scope

- `ctx.services` → `ctx.catalog`. Real overlap, but catalog holds metadata strings
  and services holds live implementation objects; folding them makes catalog
  writable, and "no write path, no override path" is a stated rule in SHR-268 and
  published at `/docs/plugin-api#not-seams`.
- `ctx.agents.run` → `ctx.fanout.run`. One item is not N items; expressing a single
  agent run as a one-element fan-out contorts the common case.
- `ctx.attention` → `ctx.ui.action`. Push (interrupt me) and pull (I click it) are
  different interactions behind a shared flag.
- Postgres, schema versioning, cross-plugin writes. Unchanged from the tickets that
  cut them.
