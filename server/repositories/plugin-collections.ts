/**
 * Repository for `plugin_collections` — the durable, keyed record store behind
 * `ctx.collections` (see `server/plugins/collections.ts`).
 *
 * Its OWN table, not `plugin_facts` with a nullable `task_id`. Same reasoning
 * as ruling R1 in `plans/2026-08-20-plugin-runtime-p0.md`: a task-scoped
 * append-only log and a durable upsert store have different lifetimes, and
 * sharing one table would share one AUTOINCREMENT sequence, one index shape,
 * and one delete-on-task-delete sweep between them. A collection row survives
 * the task that wrote it — that is the entire point of the API.
 *
 * SIGNATURES ARE PINNED. Fill in bodies and add tests; do not change an
 * exported shape.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { CollectionRecord, QuerySpec } from '@octomux/plugin-api';

export type { CollectionRecord, QuerySpec };

const logger = childLogger('repositories/plugin-collections');

/** Top-level record field names safe to splice into a `json_extract` path
 *  literal. Anything else is rejected rather than risk building the path
 *  (or an ORDER BY clause) out of arbitrary caller-supplied text. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `order` only ever becomes one of these two literals — never interpolated raw. */
const ORDER_SQL: Record<'asc' | 'desc', string> = { asc: 'ASC', desc: 'DESC' };

interface PluginCollectionRow {
  collection: string;
  key: string;
  record: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: PluginCollectionRow): CollectionRecord {
  return {
    collection: row.collection,
    key: row.key,
    record: JSON.parse(row.record),
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

/**
 * Upserts one record on `(collection, key)`. `collection` must already be
 * qualified (`<pluginId>:<name>`); `key` is the stringified value the
 * definition's `key` field held.
 */
export function upsertRecord(collection: string, key: string, record: unknown): CollectionRecord {
  getDb()
    .prepare(
      `INSERT INTO plugin_collections (collection, key, record) VALUES (?, ?, ?)
       ON CONFLICT(collection, key) DO UPDATE SET record = excluded.record, updated_at = datetime('now')`,
    )
    .run(collection, key, JSON.stringify(record ?? {}));
  logger.debug({ collection, key }, 'plugin collection record upserted');
  return getRecord(collection, key)!;
}

/** One record by its exact key, or undefined. */
export function getRecord(collection: string, key: string): CollectionRecord | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM plugin_collections WHERE collection = ? AND key = ?`)
    .get(collection, key) as PluginCollectionRow | undefined;
  return row ? toRecord(row) : undefined;
}

/**
 * Reads records from a qualified collection.
 *
 * `where` matches top-level record fields exactly, via `json_extract` — SQLite
 * ships JSON1, so this needs no new dependency and no in-memory scan.
 * `orderBy` sorts on a top-level record field; absent, rows come back by
 * `updated_at`. `limit`/`offset` window the result.
 */
export function queryRecords(collection: string, q: QuerySpec = {}): CollectionRecord[] {
  const conditions = ['collection = ?'];
  const params: Array<string | number> = [collection];

  for (const [field, value] of Object.entries(q.where ?? {})) {
    assertFieldName(field);
    conditions.push(`json_extract(record, '$.${field}') = ?`);
    params.push(bindValue(value));
  }

  const orderExpr = q.orderBy
    ? `json_extract(record, '$.${assertFieldName(q.orderBy)}')`
    : 'updated_at';
  const orderDir = ORDER_SQL[q.order ?? 'asc'];

  let sql = `SELECT * FROM plugin_collections WHERE ${conditions.join(' AND ')} ORDER BY ${orderExpr} ${orderDir}`;

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
    .all(...params) as PluginCollectionRow[];
  return rows.map(toRecord);
}

/** Deletes every record in a qualified collection. NOT called on unmount —
 *  collections are durable and outlive the plugin that defined them. Exists
 *  for tests and for a future explicit purge path. */
export function deleteCollection(collection: string): number {
  const result = getDb()
    .prepare(`DELETE FROM plugin_collections WHERE collection = ?`)
    .run(collection);
  logger.info({ collection, deleted: result.changes }, 'plugin collection deleted');
  return result.changes;
}
