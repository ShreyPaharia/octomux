# `ctx.records` Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three plugin storage APIs (`ctx.facts`, `ctx.collections`, `ctx.kv`) and their three tables with one `ctx.records` API over one `plugin_records` table.

**Architecture:** The three APIs differ on two axes only — `scope` (`task` | `durable`) and `mode` (`append` | `upsert`). One repository, one registry module, one table with a partial unique index that scopes uniqueness to keyed (upsert) rows. Definition lifetime follows row lifetime: task-scoped definitions drop on unmount, durable ones persist, which reproduces `kv`'s documented "outlives unmount" behaviour without a special case.

**Tech Stack:** TypeScript, Bun test runner, `bun:sqlite` via `better-sqlite3`-style API, ajv for JSON Schema, Express 5.

**Spec:** `docs/superpowers/specs/2026-08-22-ctx-records-collapse-design.md`

## Global Constraints

- Run `bun run typecheck`, `bun run format:check`, and `bun run test` before every commit. All three must be clean.
- Commit messages follow conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). commitlint rejects other types — `merge:` is not valid.
- A new capability name must be added to **both** `PLUGIN_CAPABILITIES` in `server/plugins/grants.ts` **and** the `PluginCapability` union in `packages/plugin-api/src/index.ts`. The manifest validator hard-rejects any name absent from that list.
- `docs/plugins/` has a drift guard: tests assert every `PluginContext` member has a heading in `api-reference.md` and every capability is named in both `README.md` and `api-reference.md`. Adding or removing either without updating docs fails the suite.
- Reads stay ungated. Only `records.define` and `records.write` are capability-gated, matching the `facts.read` / `artifacts.list` / `catalog.list` precedent.
- Migrations run on **every boot**, top to bottom, with no version table (`server/db.ts:79`). Every migration block must be idempotent and safe to re-run.
- Do not touch `server/workflows/registry.ts`. It deliberately allows re-registration over an existing kind (`presets.ts` depends on it).

---

## File Structure

**Created:**

- `server/repositories/plugin-records.ts` — all SQL for `plugin_records`. One responsibility: rows in, rows out.
- `server/repositories/plugin-records.test.ts` — repository-level tests (SQL correctness: seq stability, partial index, owner clearing).
- `server/plugins/records.ts` — the `ctx.records` registrar: definitions, qualification, schema validation, watchers, checkpoints.
- `server/plugins/records.test.ts` — registrar-level tests.

**Deleted (at the end, in Task 9):**

- `server/plugins/facts.ts`, `collections.ts`, `kv.ts` and their `.test.ts`
- `server/repositories/plugin-facts.ts`, `plugin-collections.ts`, `plugin-kv.ts` and their `.test.ts`

**Modified:**

- `server/db/migrations.ts` — new table; guarded copy; delete three old `CREATE TABLE` blocks
- `packages/plugin-api/src/index.ts` — `RecordsRegistrar`, `UiPanelBinding`, `PluginCapability`, `PluginContext`
- `server/plugins/context.ts` — wire `ctx.records`, drop `ctx.facts`/`ctx.collections`/`ctx.kv`
- `server/plugins/grants.ts` — capability list
- `server/plugins/lifecycle.ts` — unmount: drop task-scoped definitions only
- `server/plugins/catalog.ts` — `provides` reports `record:<store>`
- `server/plugins/ui-registry.ts` — single `record` field, non-optional `recordStore`
- `server/plugins/policy.ts` — core record publishing
- `server/surfaces/render.ts` — `panelsForTask` / `panelsForStore`, binding-kind branch deleted
- `server/routes/plugin-facts.ts` → renamed `server/routes/plugin-records.ts`
- `server/routes/plugin-ui.ts` — store-scoped panel route
- `server/repositories/tasks.ts:568` — sweep `plugin_records`, not `plugin_facts`
- `src/components/PluginPanels.tsx` — delete `isCollectionBound` and `recordsAsFacts`
- `docs/plugins/README.md`, `docs/plugins/api-reference.md`, `CLAUDE.md`

---

## Task 1: The `plugin_records` table and migration

**Files:**

- Modify: `server/db/migrations.ts` (add new block; delete blocks at ~1275-1332)
- Test: `server/db/migrations.test.ts`

**Interfaces:**

- Consumes: `columnsOf(instance, table)` at `server/db/migrations.ts:36`
- Produces: table `plugin_records`; helper `tableExists(instance, name): boolean` exported from `server/db/migrations.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/db/migrations.test.ts`:

```ts
it('creates plugin_records and copies plugin_facts rows into it', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // simulate an OLD database that still has the pre-collapse table
  db.exec(`CREATE TABLE plugin_facts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare(`INSERT INTO plugin_facts (task_id, type, payload) VALUES (?, ?, ?)`).run(
    't1',
    'core:review.published',
    '{"ok":true}',
  );

  runMigrations(db);

  const rows = db.prepare(`SELECT store, task_id, key, payload FROM plugin_records`).all();
  expect(rows).toEqual([
    { store: 'core:review.published', task_id: 't1', key: null, payload: '{"ok":true}' },
  ]);
  const old = db.prepare(`SELECT name FROM sqlite_master WHERE name='plugin_facts'`).all();
  expect(old).toEqual([]);
});

it('runs cleanly on a fresh database that never had the old tables', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  expect(() => runMigrations(db)).not.toThrow();
  expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='plugin_kv'`).all()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/db/migrations.test.ts -t "plugin_records"`
Expected: FAIL — `no such table: plugin_records`

- [ ] **Step 3: Add the table, the helper, and the guarded copy**

In `server/db/migrations.ts`, add near `columnsOf`:

```ts
/** True when `table` exists. The collapse migration (2026-08-22) needs this: a
 *  fresh database never ran the pre-collapse CREATE blocks, so an unguarded
 *  `INSERT ... SELECT FROM plugin_facts` would throw `no such table`. */
export function tableExists(instance: Database, table: string): boolean {
  return (
    (
      instance
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .all(table) as unknown[]
    ).length > 0
  );
}
```

Then, where the three old blocks were, one new block:

```ts
// ── ctx.records — one store for plugin data (2026-08-22) ────────────────────
// Replaces plugin_facts / plugin_collections / plugin_kv, which were one
// concept under three names differing on scope (task|durable) and mode
// (append|upsert). Still NOT the `events` table: ruling R1 keeps plugin data
// out of the orchestrator's control bus, and that is unchanged here.
//
// The partial unique index scopes uniqueness to KEYED (upsert) rows. Append
// rows have key IS NULL and are excluded, so two appends in one store never
// collide.
instance.exec(`
    CREATE TABLE IF NOT EXISTS plugin_records (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      store      TEXT NOT NULL,
      task_id    TEXT,
      key        TEXT,
      payload    TEXT NOT NULL DEFAULT '{}',
      owner      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_records_key
      ON plugin_records(store, key) WHERE key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_plugin_records_task
      ON plugin_records(task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plugin_records_store
      ON plugin_records(store, seq);
  `);

// Forward-only, self-limiting: guarded so a fresh DB skips it entirely, and
// the DROP means it never runs twice on the same database.
if (tableExists(instance, 'plugin_facts')) {
  instance.exec(`
      INSERT INTO plugin_records (store, task_id, key, payload, created_at)
      SELECT type, task_id, NULL, payload, created_at FROM plugin_facts;
      DROP TABLE plugin_facts;
    `);
  logger.info({ operation: 'collapseToPluginRecords' }, 'migrated plugin_facts');
}
if (tableExists(instance, 'plugin_collections')) {
  instance.exec(`
      INSERT INTO plugin_records (store, task_id, key, payload, created_at, updated_at)
      SELECT collection, NULL, key, record, created_at, updated_at FROM plugin_collections;
      DROP TABLE plugin_collections;
    `);
  logger.info({ operation: 'collapseToPluginRecords' }, 'migrated plugin_collections');
}
if (tableExists(instance, 'plugin_kv')) {
  instance.exec(`
      INSERT INTO plugin_records (store, task_id, key, payload, owner, created_at, updated_at)
      SELECT plugin_id || ':kv', NULL, key, value, owner, created_at, updated_at FROM plugin_kv;
      DROP TABLE plugin_kv;
    `);
  logger.info({ operation: 'collapseToPluginRecords' }, 'migrated plugin_kv');
}
```

Delete the three old `CREATE TABLE IF NOT EXISTS plugin_facts / plugin_collections / plugin_kv` blocks and their comments entirely, following this repo's decommission convention (`team_runs`, `review_learnings`: `DROP` with no surviving `CREATE`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/db/migrations.test.ts`
Expected: PASS, including the existing `is idempotent when run twice` test.

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations.ts server/db/migrations.test.ts
git commit -m "feat(db): plugin_records table with guarded migration from three old tables"
```

---

## Task 2: The repository layer

**Files:**

- Create: `server/repositories/plugin-records.ts`
- Test: `server/repositories/plugin-records.test.ts`

**Interfaces:**

- Consumes: `plugin_records` table from Task 1; `getDb()` from `server/db.js` (follow the import style in `server/repositories/plugin-collections.ts`)
- Produces:

```ts
export interface RecordRow {
  seq: number;
  store: string;
  taskId: string | null;
  key: string | null;
  payload: unknown;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}
export function appendRecord(store: string, taskId: string | null, payload: unknown): RecordRow;
export function upsertRecord(
  store: string,
  taskId: string | null,
  key: string,
  payload: unknown,
): RecordRow;
export function getRecord(store: string, key: string): RecordRow | undefined;
export function readRecordsForTask(taskId: string, store?: string): RecordRow[];
export function queryRecords(store: string, q?: QuerySpec): RecordRow[];
export function deleteRecordsForTask(taskId: string): void;
export function deleteStore(store: string): void;
export function markInFlight(store: string, key: string, payload: unknown, owner: string): void;
export function clearInFlight(store: string, key: string): void;
export function listInFlightOwnedByOthers(stores: string[], owner: string): RecordRow[];
```

- [ ] **Step 1: Write the failing tests**

Create `server/repositories/plugin-records.test.ts`:

```ts
import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import {
  appendRecord,
  upsertRecord,
  getRecord,
  queryRecords,
  readRecordsForTask,
  deleteRecordsForTask,
  markInFlight,
  clearInFlight,
  listInFlightOwnedByOthers,
} from './plugin-records.js';

beforeEach(() => {
  createTestDb();
});

describe('plugin-records repository', () => {
  it('appends two rows to one store without colliding (key IS NULL excluded from the unique index)', () => {
    appendRecord('p:log', 't1', { n: 1 });
    appendRecord('p:log', 't1', { n: 2 });
    expect(readRecordsForTask('t1', 'p:log')).toHaveLength(2);
  });

  it('upsert keeps seq and created_at stable — ON CONFLICT, never INSERT OR REPLACE', () => {
    const first = upsertRecord('p:leads', null, 'a', { v: 1 });
    const second = upsertRecord('p:leads', null, 'a', { v: 2 });
    expect(second.seq).toBe(first.seq);
    expect(second.createdAt).toBe(first.createdAt);
    expect(getRecord('p:leads', 'a')?.payload).toEqual({ v: 2 });
  });

  it('an ordinary upsert clears owner, settling an in-flight checkpoint', () => {
    markInFlight('p:kv', 'job', { step: 1 }, 'mount-A');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(1);
    upsertRecord('p:kv', null, 'job', { step: 2 });
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(0);
  });

  it('interrupted work is what some OTHER mount left behind', () => {
    markInFlight('p:kv', 'job', { step: 1 }, 'mount-A');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-A')).toHaveLength(0);
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(1);
    clearInFlight('p:kv', 'job');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(0);
  });

  it('deleteRecordsForTask removes task-scoped rows and leaves durable ones', () => {
    appendRecord('p:log', 't1', { n: 1 });
    upsertRecord('p:leads', null, 'a', { v: 1 });
    deleteRecordsForTask('t1');
    expect(readRecordsForTask('t1')).toHaveLength(0);
    expect(getRecord('p:leads', 'a')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/repositories/plugin-records.test.ts`
Expected: FAIL — cannot resolve `./plugin-records.js`

- [ ] **Step 3: Implement the repository**

Create `server/repositories/plugin-records.ts`. Model the file header, `getDb()` usage, and row-mapping style on `server/repositories/plugin-collections.ts`. The two statements that matter:

```ts
/** Upsert. ON CONFLICT — never INSERT OR REPLACE, which is delete+insert and
 *  would bump `seq` and reset `created_at`, moving the row to the end of the
 *  seq stream that append stores share.
 *
 *  The conflict target MUST repeat the partial index predicate
 *  (`WHERE key IS NOT NULL`) or SQLite cannot match the index and errors at
 *  runtime with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
 *  constraint".
 *
 *  `owner = NULL` settles any in-flight checkpoint on this key: an ordinary
 *  write means the work finished. Without it a key stays interrupted forever. */
export function upsertRecord(
  store: string,
  taskId: string | null,
  key: string,
  payload: unknown,
): RecordRow {
  getDb()
    .prepare(
      `INSERT INTO plugin_records (store, task_id, key, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(store, key) WHERE key IS NOT NULL
       DO UPDATE SET payload = excluded.payload,
                     updated_at = datetime('now'),
                     owner = NULL`,
    )
    .run(store, taskId, key, JSON.stringify(payload));
  return getRecord(store, key)!;
}

/** Append. `key` is NULL, so the partial unique index does not apply and two
 *  appends to the same store coexist. */
export function appendRecord(store: string, taskId: string | null, payload: unknown): RecordRow {
  const info = getDb()
    .prepare(
      `INSERT INTO plugin_records (store, task_id, key, payload)
       VALUES (?, ?, NULL, ?)`,
    )
    .run(store, taskId, JSON.stringify(payload));
  return rowBySeq(Number(info.lastInsertRowid));
}
```

`markInFlight` is an upsert that SETs `owner = ?` instead of NULL. `clearInFlight` is `UPDATE ... SET owner = NULL WHERE store = ? AND key = ?`. `listInFlightOwnedByOthers(stores, owner)` is `WHERE store IN (...) AND owner IS NOT NULL AND owner != ?`.

`queryRecords` ports the existing `QuerySpec` handling from `server/repositories/plugin-collections.ts:queryRecords` unchanged — `where` / `orderBy` / `order` / `limit` / `offset`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/repositories/plugin-records.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/repositories/plugin-records.ts server/repositories/plugin-records.test.ts
git commit -m "feat(db): plugin-records repository with seq-stable upsert and checkpoint owner"
```

---

## Task 3: Types in `@octomux/plugin-api`

**Files:**

- Modify: `packages/plugin-api/src/index.ts`

**Interfaces:**

- Produces: `RecordsRegistrar`, `RecordStoreDefinition`, `RecordEnvelope`, updated `UiPanelBinding`, updated `PluginCapability`, updated `PluginContext`

- [ ] **Step 1: Add the types**

```ts
export interface RecordStoreDefinition {
  /** BARE local name — the host qualifies it to `<pluginId>:<name>`. */
  name: string;
  /** JSON Schema validated on write. Omit for an opaque store (the old ctx.kv). */
  schema?: Record<string, unknown>;
  /** Record field used as identity. Required when `mode` is 'upsert'. */
  key?: string;
  /** 'task' rows die with their task; 'durable' rows outlive unmount. */
  scope: 'task' | 'durable';
  /** 'append' adds a row; 'upsert' replaces the row with the same key. */
  mode: 'append' | 'upsert';
}

/** What `read`, `query` and `watch` hand back. Uniform across every scope and
 *  mode: the pre-collapse ctx.facts fired a full envelope while ctx.collections
 *  fired a bare record, and one shape is strictly more information. */
export interface RecordEnvelope {
  seq: number;
  store: string;
  taskId: string | null;
  key: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RecordsRegistrar {
  define(def: RecordStoreDefinition): void;
  put(name: string, record: unknown, opts?: { taskId?: string }): Promise<void>;
  read(name: string, opts?: { taskId: string }): Promise<RecordEnvelope[]>;
  query(name: string, q?: QuerySpec): Promise<RecordEnvelope[]>;
  watch(qualifiedName: string, onRecord: (rec: RecordEnvelope) => void): () => void;
  /** Checkpoints (from the pre-collapse ctx.kv). `name` is required: one plugin
   *  can own several stores, and a per-plugin checkpoint key would let two of
   *  them collide — a failure the flat plugin_kv namespace could not have. */
  begin(name: string, key: string, value: unknown): void;
  end(name: string, key: string): void;
  /** Checkpoints left by some OTHER mount — by construction, work that never
   *  finished. Omit `name` for every store this plugin owns. */
  interrupted(name?: string): RecordEnvelope[];
}
```

Replace the `UiFactPanelBinding | UiCollectionPanelBinding` union with:

```ts
export interface UiPanelBinding {
  slot: UiSlot;
  /** BARE local store name — the host qualifies it. */
  record: string;
  as: UiRenderer | string;
  value?: string;
  delta?: string;
  title?: string;
}
```

In `PluginCapability`, delete `'facts.define'`, `'facts.put'`, `'collections.define'`, `'collections.write'`, `'kv.write'`; add `'records.define'` and `'records.write'`.

In `PluginContext`, delete `readonly facts`, `readonly collections`, `readonly kv`; add `readonly records: RecordsRegistrar;`.

- [ ] **Step 2: Run typecheck to see the blast radius**

Run: `bun run typecheck`
Expected: FAIL, with errors in `context.ts`, `ui-registry.ts`, `render.ts`, `catalog.ts`, `lifecycle.ts`, `policy.ts`, `PluginPanels.tsx`. That list is the work of Tasks 4–8.

- [ ] **Step 3: Commit the types alone**

```bash
git add packages/plugin-api/src/index.ts
git commit -m "feat(plugin-api): RecordsRegistrar replaces facts/collections/kv types"
```

Typecheck is red at this commit by design; Task 9 is the gate that requires it green.

---

## Task 4: The `records` registrar

**Files:**

- Create: `server/plugins/records.ts`
- Test: `server/plugins/records.test.ts`

**Interfaces:**

- Consumes: `server/repositories/plugin-records.js` (Task 2); `qualify()` from `server/plugins/qualify.js`
- Produces:

```ts
export function defineStore(pluginId: string, def: RecordStoreDefinition): void;
export function putRecord(
  pluginId: string,
  name: string,
  record: unknown,
  taskId?: string,
): Promise<void>;
export function readStore(
  pluginId: string,
  name: string,
  taskId: string,
): Promise<RecordEnvelope[]>;
export function queryStore(
  pluginId: string,
  name: string,
  q?: QuerySpec,
): Promise<RecordEnvelope[]>;
export function watchStore(
  watcherId: string,
  qualified: string,
  cb: (r: RecordEnvelope) => void,
): () => void;
export function beginCheckpoint(
  pluginId: string,
  name: string,
  key: string,
  value: unknown,
  mountId: string,
): void;
export function endCheckpoint(pluginId: string, name: string, key: string): void;
export function interruptedFor(pluginId: string, mountId: string, name?: string): RecordEnvelope[];
export function unregisterTaskScopedStores(pluginId: string): string[];
export function listPluginStores(pluginId: string): string[];
export function isStoreDefined(qualified: string): boolean;
export const CORE_RECORD_STORES: readonly string[];
export function publishCoreRecord(qualifiedStore: string, taskId: string, payload: unknown): void;
export function resetRecords(): void;
```

- [ ] **Step 1: Write the failing tests**

Create `server/plugins/records.test.ts`. These six carry over behaviour that existing suites pin — each is a regression test for a bug that already shipped once:

```ts
it('redefining a store after unregister validates against the NEW schema', () => {
  // ports facts.test.ts:177 + collections.test.ts:270 — the ajv validator cache
  // is keyed by qualified name and MUST be busted on redefine
  defineStore('p', {
    name: 's',
    scope: 'task',
    mode: 'append',
    schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
  });
  unregisterTaskScopedStores('p');
  defineStore('p', {
    name: 's',
    scope: 'task',
    mode: 'append',
    schema: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
  });
  expect(putRecord('p', 's', { b: 'ok' }, 't1')).resolves.toBeUndefined();
  expect(putRecord('p', 's', { a: 1 }, 't1')).rejects.toThrow(/schema/i);
});

it("reloading the defining plugin does not kill another plugin's watcher", () => {
  // ports facts.test.ts:206 + collections.test.ts:248 — watcher lifetime belongs
  // to the WATCHING plugin, not the defining one
  defineStore('owner', { name: 's', scope: 'task', mode: 'append' });
  const seen: RecordEnvelope[] = [];
  watchStore('observer', 'owner:s', (r) => seen.push(r));
  unregisterTaskScopedStores('owner');
  defineStore('owner', { name: 's', scope: 'task', mode: 'append' });
  await putRecord('owner', 's', { n: 1 }, 't1');
  expect(seen).toHaveLength(1);
});

it('rejects a non-scalar key value and stringifies a numeric one', () => {
  // ports collections.test.ts:65-129
  defineStore('p', { name: 'c', scope: 'durable', mode: 'upsert', key: 'id' });
  expect(putRecord('p', 'c', { id: 7 })).resolves.toBeUndefined();
  expect(putRecord('p', 'c', { id: { nested: true } })).rejects.toThrow(/string or number/);
});

it('rejects a qualified name passed to put — cross-plugin writes are out of scope', () => {
  // ports collections.test.ts:139
  defineStore('p', { name: 'c', scope: 'durable', mode: 'upsert', key: 'id' });
  expect(putRecord('p', 'other:c', { id: '1' })).rejects.toThrow(/bare local name/);
});

it('rejects append+key and upsert-without-key at define time', () => {
  expect(() => defineStore('p', { name: 'a', scope: 'task', mode: 'append', key: 'id' })).toThrow(
    /append/,
  );
  expect(() => defineStore('p', { name: 'b', scope: 'durable', mode: 'upsert' })).toThrow(/key/);
});

it('rejects a taskId on a durable store and a missing one on a task store', () => {
  defineStore('p', { name: 'd', scope: 'durable', mode: 'upsert', key: 'id' });
  defineStore('p', { name: 't', scope: 'task', mode: 'append' });
  expect(putRecord('p', 'd', { id: '1' }, 'task-1')).rejects.toThrow(/durable/);
  expect(putRecord('p', 't', { n: 1 })).rejects.toThrow(/taskId/);
});

it('two stores owned by one plugin do not collide on a checkpoint key', () => {
  defineStore('p', { name: 'x', scope: 'durable', mode: 'upsert', key: 'id' });
  defineStore('p', { name: 'y', scope: 'durable', mode: 'upsert', key: 'id' });
  beginCheckpoint('p', 'x', 'job', { a: 1 }, 'mount-A');
  beginCheckpoint('p', 'y', 'job', { b: 2 }, 'mount-A');
  const left = interruptedFor('p', 'mount-B');
  expect(left.map((r) => r.store).sort()).toEqual(['p:x', 'p:y']);
  endCheckpoint('p', 'x', 'job');
  expect(interruptedFor('p', 'mount-B').map((r) => r.store)).toEqual(['p:y']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/plugins/records.test.ts`
Expected: FAIL — cannot resolve `./records.js`

- [ ] **Step 3: Implement `records.ts`**

Port from the three modules being replaced rather than writing fresh:

- definition map, qualification and the ajv validator cache (with its bust-on-redefine) from `server/plugins/facts.ts`
- key validation and `QuerySpec` handling from `server/plugins/collections.ts`
- checkpoint semantics from `server/plugins/kv.ts`

Add the two validations that were conventions rather than rules: `mode:'append'` with `key` set, and `mode:'upsert'` without `key`, both rejected at `define()`.

`unregisterTaskScopedStores(pluginId)` drops **only** definitions whose `scope` is `'task'`, and returns their qualified names. Header comment:

```ts
/** Definition lifetime follows ROW lifetime. Task-scoped rows die with their
 *  task, so their definitions drop on unmount. Durable rows outlive unmount, so
 *  their definitions must too — a durable store whose rows survive but whose
 *  definition vanished would be unreadable, and the pre-collapse ctx.kv relied
 *  on exactly that (it had no unmount hook at all, so a hot-reloaded plugin
 *  found its in-flight checkpoints on the next apply()). */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/plugins/records.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/plugins/records.ts server/plugins/records.test.ts
git commit -m "feat(plugins): ctx.records registrar with scope/mode and store-scoped checkpoints"
```

---

## Task 5: Wire `ctx.records` into the context and grants

**Files:**

- Modify: `server/plugins/context.ts`, `server/plugins/grants.ts`
- Test: `server/plugins/context.test.ts`

**Interfaces:**

- Consumes: everything Task 4 produces
- Produces: `ctx.records` on the live `PluginContext`

- [ ] **Step 1: Write the failing test**

In `server/plugins/context.test.ts`, extend the "denied every gated registrar" case and the one-grant table:

```ts
expect(() => ctx.records.define({ name: 's', scope: 'task', mode: 'append' })).toThrow(
  /not granted/,
);
await expect(ctx.records.put('s', { n: 1 }, { taskId: 't1' })).rejects.toThrow(/not granted/);
```

```ts
['records.define', (ctx) => ctx.records.define({ name: 's', scope: 'task', mode: 'append' })],
['records.write', (ctx) => { const p = ctx.records.put('s', { n: 1 }, { taskId: 't' }); p.catch(() => {}); }],
```

And pin that reads stay ungated:

```ts
it('records reads stay ungated, matching facts.read and catalog.list', async () => {
  const ctx = createPluginContext('nogrants');
  await expect(ctx.records.query('s')).rejects.not.toThrow(/not granted/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/plugins/context.test.ts -t records`
Expected: FAIL — `ctx.records` is undefined

- [ ] **Step 3: Wire it**

In `server/plugins/grants.ts`: delete `'facts.define'`, `'facts.put'`, `'collections.define'`, `'collections.write'`, `'kv.write'` from `PLUGIN_CAPABILITIES`; add `'records.define'`, `'records.write'`.

In `server/plugins/context.ts`: delete the `facts`, `collections` and `kv` const blocks and their imports; add a `records` block calling into `server/plugins/records.js`. Gate `define` on `records.define` and `put`/`begin`/`end` on `records.write` with `assertGranted`. **Do not** add `assertLive` — follow the existing reasoning already written above the old `facts.put`: the revoke guard exists to stop a timed-out `apply()` mutating live REGISTRIES, and a record write is data, not registration. Add `records` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/plugins/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/plugins/context.ts server/plugins/grants.ts server/plugins/context.test.ts
git commit -m "feat(plugins): wire ctx.records, replace five capabilities with two"
```

---

## Task 6: Lifecycle, catalog, policy, and the task-deletion sweep

**Files:**

- Modify: `server/plugins/lifecycle.ts`, `server/plugins/catalog.ts`, `server/plugins/policy.ts`, `server/repositories/tasks.ts:568`
- Test: `server/plugins/lifecycle.test.ts`, `server/plugins/catalog.test.ts`

**Interfaces:**

- Consumes: `unregisterTaskScopedStores`, `listPluginStores`, `publishCoreRecord`, `deleteRecordsForTask`

- [ ] **Step 1: Write the failing tests**

```ts
// lifecycle.test.ts — the rule that replaces kv's special case
it('unmount drops task-scoped store definitions and RETAINS durable ones', async () => {
  const ctx = createPluginContext('p', ['records.define', 'records.write']);
  ctx.records.define({ name: 'ephemeral', scope: 'task', mode: 'append' });
  ctx.records.define({ name: 'lasting', scope: 'durable', mode: 'upsert', key: 'id' });
  await unmountPlugin('p', ctx);
  expect(isStoreDefined('p:ephemeral')).toBe(false);
  expect(isStoreDefined('p:lasting')).toBe(true);
});
```

```ts
// tasks.test.ts — the sweep that lives outside server/plugins/
it('hardDeleteTask sweeps task-scoped records and leaves durable ones', () => {
  appendRecord('p:log', 'task-1', { n: 1 });
  upsertRecord('p:leads', null, 'a', { v: 1 });
  hardDeleteTask('task-1');
  expect(readRecordsForTask('task-1')).toHaveLength(0);
  expect(getRecord('p:leads', 'a')).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/plugins/lifecycle.test.ts server/repositories/tasks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`lifecycle.ts`: replace the facts/collections unregister calls with one `unregisterTaskScopedStores(pluginId)`. Update the `released` report field to `recordStores`.

`catalog.ts`: `pluginRegistrations` gains `recordStores: string[]` from `listPluginStores(pluginId)`; drop `factTypes` and `collectionNames`. `pluginProvides` emits `record:<store>`. Update the ordering doc comment to `harnesses, integrations, surfaces, routes, ui, ui-action, records, services`.

`policy.ts`: `publishCoreRecord('core:policy.decision', taskId, payload)` replaces the core fact publish.

`server/repositories/tasks.ts`: replace the `deleteFactsForTask` import and its call at line 568 with `deleteRecordsForTask`. **Keep the surrounding comment** explaining why there is no FK cascade — it is still true — and update it to say `plugin_records`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/plugins/ server/repositories/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/plugins/lifecycle.ts server/plugins/catalog.ts server/plugins/policy.ts server/repositories/tasks.ts server/plugins/lifecycle.test.ts server/repositories/tasks.test.ts
git commit -m "feat(plugins): definition lifetime follows row lifetime; sweep plugin_records on task delete"
```

---

## Task 7: UI registry, render paths, and routes

**Files:**

- Modify: `server/plugins/ui-registry.ts`, `server/surfaces/render.ts`, `server/surfaces/text.ts`, `server/routes/plugin-ui.ts`
- Rename: `server/routes/plugin-facts.ts` → `server/routes/plugin-records.ts`
- Test: `server/surfaces/portability.test.ts`, `server/plugins/ui-registry.test.ts`

**Interfaces:**

- Consumes: `UiPanelBinding` (Task 3), `readStore` / `queryStore` (Task 4)
- Produces: `panelsForTask(kind, taskId)`, `panelsForStore(kind, store, q?)`

- [ ] **Step 1: Write the failing test**

`portability.test.ts` **keeps both `describe` blocks.** The second is the only coverage of the durable/no-task path and of the SHR-279 regression itself; collapsing to one block would let a broken durable path pass silently — SHR-279's exact failure mode, one level deeper.

```ts
it('a binding registered before a surface existed renders on it once added — task-scoped', async () => {
  // existing first-block assertions, with `fact:` swapped for `record:`
});

it('the same holds for a durable store rendered via panelsForStore', async () => {
  registerPluginUiPanel('pipeline-bot', { slot: 'settings.card', record: 'leads', as: 'table' });
  registerSurface({ kind: 'demo:discord', render: (p) => `${p.records.length} rows` });
  const panels = await panelsForStore('demo:discord', 'pipeline-bot:leads', { limit: 10 });
  expect(panels).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/surfaces/portability.test.ts`
Expected: FAIL — `record` is not a known binding field

- [ ] **Step 3: Implement**

`ui-registry.ts`: `UiContribution` becomes `UiPanelBinding & { pluginId: string; recordStore: string }` — `recordStore` non-optional. Delete the neither/both `fact`/`collection` validation and replace with a single required-`record` check.

`render.ts`: delete `if (!c.factType) continue`. Rename `panelsForSurface` → `panelsForTask` and `renderCollectionPanels` → `panelsForStore`. **Both survive.** Add this comment above them:

```ts
/** Two entry points, differing by WHAT is rendered — a task's panels, or one
 *  store's board — not by binding kind. The binding-kind branch is gone; the
 *  second function is not, because panelsForStore carries a QuerySpec that
 *  windows an unbounded store ("a 2,000-record board does not need every row in
 *  a Slack message"). A merged walk has nowhere to put per-store limit/offset,
 *  and one window shared across stores with different schemas is meaningless. */
```

Delete the local `recordsAsFacts` adapter: both paths now hand `RecordEnvelope[]` to `render` directly, which is what keeps `render` from branching on binding kind.

Rename the route file and change its paths from `/api/plugin-facts/...` to `/api/plugin-records/...`. Update `server/registry/route-inventory.test.ts` to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/surfaces/ server/plugins/ui-registry.test.ts server/registry/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/plugins/ui-registry.ts server/surfaces/ server/routes/ server/registry/
git commit -m "feat(surfaces): single record binding; panelsForTask and panelsForStore"
```

---

## Task 8: The client twin

**Files:**

- Modify: `src/components/PluginPanels.tsx`, `src/workflows/renderers/index.tsx`
- Test: `src/components/PluginPanels.test.tsx`

**Interfaces:**

- Consumes: the `/api/plugin-records` and `/api/plugin-ui` shapes from Task 7

- [ ] **Step 1: Write the failing test**

```tsx
it('renders a panel from a record store without branching on binding kind', async () => {
  render(<PluginPanels slot="task.panel" taskId="t1" />);
  expect(await screen.findByText('81%')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:client -- PluginPanels`
Expected: FAIL

- [ ] **Step 3: Implement**

Delete `isCollectionBound` (`src/components/PluginPanels.tsx:76`) and the local `recordsAsFacts` adapter (line ~53). The component now consumes `RecordEnvelope[]` uniformly — this is the client half of the same duplication `render.ts` had, and leaving it makes the collapse only half real.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:client`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "refactor(client): drop the fact/collection branch from PluginPanels"
```

---

## Task 9: Delete the old modules and update the docs

**Files:**

- Delete: `server/plugins/{facts,collections,kv}.ts` + tests; `server/repositories/{plugin-facts,plugin-collections,plugin-kv}.ts` + tests
- Modify: `docs/plugins/README.md`, `docs/plugins/api-reference.md`, `CLAUDE.md`, `server/plugins/integration.test.ts`

- [ ] **Step 1: Delete the replaced modules**

```bash
git rm server/plugins/facts.ts server/plugins/facts.test.ts \
       server/plugins/collections.ts server/plugins/collections.test.ts \
       server/plugins/kv.ts server/plugins/kv.test.ts \
       server/repositories/plugin-facts.ts server/repositories/plugin-facts.test.ts \
       server/repositories/plugin-collections.ts server/repositories/plugin-collections.test.ts \
       server/repositories/plugin-kv.ts server/repositories/plugin-kv.test.ts
```

- [ ] **Step 2: Update every fixture that names an old capability**

`server/plugins/integration.test.ts` hardcodes `grants: [facts.put]` and `grants: [facts.define, facts.put]` at lines 244, 333 and in the `acknowledgeGrants` widen-flow test at 676-699. Rename all to `records.define` / `records.write`. A partial rename can leave a test unexercised rather than failing loudly, so grep to confirm zero remain:

```bash
grep -rn "facts\.\(put\|define\)\|collections\.\(write\|define\)\|kv\.write" server/ src/ docs/ CLAUDE.md
```

Expected: no output.

- [ ] **Step 3: Update the docs (the drift guard enforces this)**

`docs/plugins/api-reference.md`: replace the `ctx.facts`, `ctx.collections` and `ctx.kv` sections with one `### ctx.records` section covering `define`, `put`, `read`, `query`, `watch`, the checkpoint trio, the scope/mode table, and which capability gates what. Update the `PluginContext` member table and the capability table.

`docs/plugins/README.md`: same capability-table edit; update the registrar list.

`CLAUDE.md`: update the `ctx` member list and the capability list.

- [ ] **Step 4: Full verification — this is the gate**

```bash
bun run typecheck && bun run format:check && bun run lint && bun run test
```

Expected: all clean. Typecheck has been red since Task 3 and must be green here.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(plugins): delete facts/collections/kv, one ctx.records remains

Three storage APIs over three tables were one concept under three names,
differing on scope (task|durable) and mode (append|upsert).

Deletes the UiPanelBinding discriminated union, the `if (!c.factType) continue`
skip in render.ts and its client twin in PluginPanels.tsx, and three capability
names. SHR-279 existed only because facts and collections were separate stores."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: table + migration → 1; repository incl. `ON CONFLICT`/`owner = NULL` → 2; API types + envelope + capabilities → 3; registrar, definition-lifetime rule, store-scoped checkpoints → 4; context wiring + grants → 5; lifecycle, catalog, core records, `hardDeleteTask` sweep → 6; UI binding, two render entry points, routes → 7; client twin → 8; deletion, fixtures, docs → 9. All six named regression tests appear in Tasks 2 and 4. The four duplicated kind registries are explicitly out of scope in the spec and get no task.

**Placeholders.** None — no TBD/TODO, every code step carries real code, no "similar to Task N".

**Type consistency.** `RecordEnvelope` is used in Tasks 3, 4, 7, 8 with the same seven fields. `upsertRecord(store, taskId, key, payload)` has the same signature in Tasks 2 and 6. `unregisterTaskScopedStores` is named identically in Tasks 4 and 6. `panelsForTask` / `panelsForStore` are consistent across Task 7 and the spec.

**One deliberate red state:** typecheck is broken from Task 3 (types change) until Task 9 (last consumer updated). Task 3 says so, and Task 9's Step 4 is the gate. Tasks 4–8 each keep their own unit tests green.
