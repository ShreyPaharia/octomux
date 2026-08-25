/**
 * Repository for `plugin_records` — the single table behind `ctx.records`,
 * collapsing what were three separate stores (`plugin_facts`,
 * `plugin_collections`, `plugin_kv`) into one append-and-upsert log. See
 * `plans/2026-08-22-ctx-records-collapse.md`.
 *
 * A row is either an APPEND (`key IS NULL`, task-scoped, immutable, ordered
 * by `seq`) or a KEYED record (`key` set, durable, upserted via
 * `ON CONFLICT(store, key)`). The partial unique index on
 * `(store, key) WHERE key IS NOT NULL` is what lets both shapes share one
 * table: two appends never collide, two writes to the same key always do.
 *
 * `owner` is the in-flight checkpoint column: a keyed row can be marked
 * "being worked on by mount X" and later settled by either an explicit
 * `clearInFlight` or simply by any ordinary `upsertRecord` on that key.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { QuerySpec } from '@octomux/plugin-api';

export type { QuerySpec };

const logger = childLogger('repositories/plugin-records');

/** Top-level payload field names safe to splice into a `json_extract` path
 *  literal. Anything else is rejected rather than risk building the path
 *  (or an ORDER BY clause) out of arbitrary caller-supplied text. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `order` only ever becomes one of these two literals — never interpolated raw. */
const ORDER_SQL: Record<'asc' | 'desc', string> = { asc: 'ASC', desc: 'DESC' };

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

interface PluginRecordRow {
  seq: number;
  store: string;
  task_id: string | null;
  key: string | null;
  payload: string;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: PluginRecordRow): RecordRow {
  return {
    seq: row.seq,
    store: row.store,
    taskId: row.task_id,
    key: row.key,
    payload: JSON.parse(row.payload),
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertFieldName(field: string): string {
  if (!FIELD_NAME_RE.test(field)) {
    throw new Error(`invalid field name "${field}"`);
  }
  return field;
}

/** Binds a filter/order value the way `json_extract` hands one back: a string
 *  stays a string, a number stays a number, a boolean becomes SQLite's 0/1. */
function bindValue(value: unknown): string | number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(`unsupported filter value type: ${typeof value}`);
}

function rowBySeq(seq: number): RecordRow {
  const row = getDb().prepare(`SELECT * FROM plugin_records WHERE seq = ?`).get(seq) as
    | PluginRecordRow
    | undefined;
  if (!row) throw new Error(`plugin_records row seq=${seq} vanished after insert`);
  return toRecord(row);
}

/** Append. `key` is NULL, so the partial unique index does not apply and two
 *  appends to the same store coexist. */
export function appendRecord(store: string, taskId: string | null, payload: unknown): RecordRow {
  const info = getDb()
    .prepare(
      `INSERT INTO plugin_records (store, task_id, key, payload)
       VALUES (?, ?, NULL, ?)`,
    )
    .run(store, taskId, JSON.stringify(payload ?? {}));
  logger.debug({ store, taskId }, 'plugin record appended');
  return rowBySeq(Number(info.lastInsertRowid));
}

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
    .run(store, taskId, key, JSON.stringify(payload ?? {}));
  logger.debug({ store, key }, 'plugin record upserted');
  return getRecord(store, key)!;
}

/** One keyed record by its exact key, or undefined. */
export function getRecord(store: string, key: string): RecordRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM plugin_records WHERE store = ? AND key = ?`)
    .get(store, key) as PluginRecordRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** Every row (appended or keyed) written for a task, optionally scoped to
 *  one store, ordered by `seq`. */
export function readRecordsForTask(taskId: string, store?: string): RecordRow[] {
  const conditions = ['task_id = ?'];
  const params: Array<string> = [taskId];
  if (store !== undefined) {
    conditions.push('store = ?');
    params.push(store);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM plugin_records WHERE ${conditions.join(' AND ')} ORDER BY seq`)
    .all(...params) as PluginRecordRow[];
  return rows.map(toRecord);
}

/**
 * Reads records from a store.
 *
 * `where` matches top-level payload fields exactly, via `json_extract` —
 * SQLite ships JSON1, so this needs no new dependency and no in-memory scan.
 * `orderBy` sorts on a top-level payload field; absent, rows come back by
 * `updated_at`. `limit`/`offset` window the result.
 */
export function queryRecords(store: string, q: QuerySpec = {}): RecordRow[] {
  const conditions = ['store = ?'];
  const params: Array<string | number> = [store];

  for (const [field, value] of Object.entries(q.where ?? {})) {
    assertFieldName(field);
    conditions.push(`json_extract(payload, '$.${field}') = ?`);
    params.push(bindValue(value));
  }

  const orderExpr = q.orderBy
    ? `json_extract(payload, '$.${assertFieldName(q.orderBy)}')`
    : 'updated_at';
  const orderDir = ORDER_SQL[q.order ?? 'asc'];

  let sql = `SELECT * FROM plugin_records WHERE ${conditions.join(' AND ')} ORDER BY ${orderExpr} ${orderDir}`;

  // SQLite requires LIMIT before OFFSET; -1 means "unbounded" so an offset
  // alone still works. Both are bound as parameters, coerced to safe integers.
  if (q.limit !== undefined || q.offset !== undefined) {
    sql += ' LIMIT ?';
    params.push(q.limit !== undefined ? Math.max(0, Math.trunc(q.limit)) : -1);
    if (q.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(Math.max(0, Math.trunc(q.offset)));
    }
  }

  const rows = getDb()
    .prepare(sql)
    .all(...params) as PluginRecordRow[];
  return rows.map(toRecord);
}

/** Deletes every row written for a task — task-scoped rows only. Durable
 *  keyed records written with `taskId: null` are untouched. */
export function deleteRecordsForTask(taskId: string): void {
  const result = getDb().prepare(`DELETE FROM plugin_records WHERE task_id = ?`).run(taskId);
  logger.info({ taskId, deleted: result.changes }, 'plugin records deleted for task');
}

/** Deletes every row in a store, appended and keyed alike. NOT called on
 *  unmount — exists for tests and for a future explicit purge path. */
export function deleteStore(store: string): void {
  const result = getDb().prepare(`DELETE FROM plugin_records WHERE store = ?`).run(store);
  logger.info({ store, deleted: result.changes }, 'plugin store deleted');
}

/** Upsert that leaves the row marked in-flight, owned by `owner`, instead of
 *  settling it. Same ON CONFLICT shape as `upsertRecord`, but `owner` is set
 *  to the caller rather than cleared. */
export function markInFlight(store: string, key: string, payload: unknown, owner: string): void {
  getDb()
    .prepare(
      `INSERT INTO plugin_records (store, task_id, key, payload, owner)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(store, key) WHERE key IS NOT NULL
       DO UPDATE SET payload = excluded.payload,
                     updated_at = datetime('now'),
                     owner = excluded.owner`,
    )
    .run(store, key, JSON.stringify(payload ?? {}), owner);
}

/** Settles an in-flight checkpoint without changing the payload. */
export function clearInFlight(store: string, key: string): void {
  getDb()
    .prepare(
      `UPDATE plugin_records SET owner = NULL, updated_at = datetime('now')
       WHERE store = ? AND key = ?`,
    )
    .run(store, key);
}

/** Rows across the given stores currently in-flight and owned by someone
 *  other than `owner` — i.e. interrupted work some OTHER mount left behind. */
export function listInFlightOwnedByOthers(stores: string[], owner: string): RecordRow[] {
  if (stores.length === 0) return [];
  const placeholders = stores.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM plugin_records
       WHERE store IN (${placeholders}) AND owner IS NOT NULL AND owner != ?
       ORDER BY seq`,
    )
    .all(...stores, owner) as PluginRecordRow[];
  return rows.map(toRecord);
}
