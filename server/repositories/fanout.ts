/**
 * Repository for `fanout_runs` / `fanout_items` — fan-out (SHR-276): run a
 * step per item, not per schedule. See the migration comment in
 * `server/db/migrations.ts` for why these are their own tables rather than a
 * row in `runs`.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/fanout');

export type FanOutRunStatusValue = 'running' | 'done' | 'failed' | 'canceled';
export type FanOutItemStatusValue = 'pending' | 'running' | 'done' | 'dead';

export interface FanOutRunRecord {
  id: string;
  pluginId: string;
  /** Qualified `<pluginId>:<name>`. */
  name: string;
  status: FanOutRunStatusValue;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface FanOutItemRecord {
  runId: string;
  key: string;
  status: FanOutItemStatusValue;
  attempts: number;
  /** The item as handed in, JSON round-tripped. */
  item: unknown;
  result?: unknown;
  error?: string;
  updatedAt: string;
}

interface FanOutRunRow {
  id: string;
  plugin_id: string;
  name: string;
  status: FanOutRunStatusValue;
  total: number;
  created_at: string;
  updated_at: string;
}

interface FanOutItemRow {
  run_id: string;
  item_key: string;
  status: FanOutItemStatusValue;
  attempts: number;
  item_json: string;
  result_json: string | null;
  error: string | null;
  updated_at: string;
}

function toFanOutRunRecord(row: FanOutRunRow): FanOutRunRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    name: row.name,
    status: row.status,
    total: row.total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFanOutItemRecord(row: FanOutItemRow): FanOutItemRecord {
  const record: FanOutItemRecord = {
    runId: row.run_id,
    key: row.item_key,
    status: row.status,
    attempts: row.attempts,
    item: JSON.parse(row.item_json),
    updatedAt: row.updated_at,
  };
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  if (row.error !== null) record.error = row.error;
  return record;
}

/** New run, `status: 'running'`, `total: 0`. `qualifiedName` is `<pluginId>:<name>`. */
export function createFanOutRun(pluginId: string, qualifiedName: string): FanOutRunRecord {
  const id = nanoid(12);
  getDb()
    .prepare(`INSERT INTO fanout_runs (id, plugin_id, name) VALUES (?, ?, ?)`)
    .run(id, pluginId, qualifiedName);
  const row = getFanOutRun(id);
  if (!row) throw new Error('failed to read fanout_run after insert');
  logger.debug({ run_id: id, plugin_id: pluginId, name: qualifiedName }, 'fanout_run created');
  return row;
}

export function getFanOutRun(runId: string): FanOutRunRecord | undefined {
  const row = getDb().prepare(`SELECT * FROM fanout_runs WHERE id = ?`).get(runId) as
    | FanOutRunRow
    | undefined;
  return row ? toFanOutRunRecord(row) : undefined;
}

/** Newest first. `limit` defaults to 50. */
export function listFanOutRuns(
  opts: { pluginId?: string; name?: string; limit?: number } = {},
): FanOutRunRecord[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts.pluginId !== undefined) {
    conditions.push('plugin_id = ?');
    params.push(opts.pluginId);
  }
  if (opts.name !== undefined) {
    conditions.push('name = ?');
    params.push(opts.name);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(opts.limit ?? 50);
  const rows = getDb()
    .prepare(`SELECT * FROM fanout_runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as FanOutRunRow[];
  return rows.map(toFanOutRunRecord);
}

/** Also touches `updated_at`. */
export function setFanOutRunStatus(runId: string, status: FanOutRunStatusValue): void {
  getDb()
    .prepare(`UPDATE fanout_runs SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, runId);
  logger.debug({ run_id: runId, status }, 'fanout_run status set');
}

/** Also touches `updated_at`. */
export function setFanOutRunTotal(runId: string, total: number): void {
  getDb()
    .prepare(`UPDATE fanout_runs SET total = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(total, runId);
  logger.debug({ run_id: runId, total }, 'fanout_run total set');
}

/**
 * Inserts item rows that don't exist yet and leaves existing rows completely
 * untouched (status, attempts, result all preserved) — this is what makes a
 * re-run over the same source skip work already done. Runs in one transaction.
 */
export function upsertFanOutItems(
  runId: string,
  items: ReadonlyArray<{ key: string; item: unknown }>,
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO fanout_items (run_id, item_key, item_json) VALUES (?, ?, ?)`,
  );
  db.transaction(() => {
    for (const { key, item } of items) {
      insert.run(runId, key, JSON.stringify(item ?? null));
    }
  })();
  logger.debug({ run_id: runId, count: items.length }, 'fanout_items upserted');
}

/** All items for a run, insertion order (rowid ASC). */
export function listFanOutItems(runId: string): FanOutItemRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM fanout_items WHERE run_id = ? ORDER BY rowid ASC`)
    .all(runId) as FanOutItemRow[];
  return rows.map(toFanOutItemRecord);
}

/** Items with status 'pending', insertion order. */
export function pendingFanOutItems(runId: string): FanOutItemRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM fanout_items WHERE run_id = ? AND status = 'pending' ORDER BY rowid ASC`,
    )
    .all(runId) as FanOutItemRow[];
  return rows.map(toFanOutItemRecord);
}

/** Partial update of one item row; always touches `updated_at`.
 *  `result`/`error` are only written when the key is present in `patch`. */
export function setFanOutItemStatus(
  runId: string,
  key: string,
  patch: {
    status: FanOutItemStatusValue;
    attempts?: number;
    result?: unknown;
    error?: string | null;
  },
): void {
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const params: Array<string | number | null> = [patch.status];
  if (patch.attempts !== undefined) {
    sets.push('attempts = ?');
    params.push(patch.attempts);
  }
  if ('result' in patch) {
    sets.push('result_json = ?');
    params.push(patch.result === undefined ? null : JSON.stringify(patch.result));
  }
  if ('error' in patch) {
    sets.push('error = ?');
    params.push(patch.error ?? null);
  }
  params.push(runId, key);
  getDb()
    .prepare(`UPDATE fanout_items SET ${sets.join(', ')} WHERE run_id = ? AND item_key = ?`)
    .run(...params);
  logger.debug({ run_id: runId, item_key: key, status: patch.status }, 'fanout_item status set');
}

/** Redrive: every 'dead' item back to 'pending' with attempts reset to 0 and
 *  error cleared. Returns how many rows changed. */
export function resetDeadFanOutItems(runId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE fanout_items
       SET status = 'pending', attempts = 0, error = NULL, updated_at = datetime('now')
       WHERE run_id = ? AND status = 'dead'`,
    )
    .run(runId);
  logger.debug({ run_id: runId, count: result.changes }, 'dead fanout_items reset');
  return result.changes;
}

/** Crash/abort recovery: every 'running' item back to 'pending' (attempts kept).
 *  Returns how many rows changed. */
export function resetRunningFanOutItems(runId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE fanout_items
       SET status = 'pending', updated_at = datetime('now')
       WHERE run_id = ? AND status = 'running'`,
    )
    .run(runId);
  logger.debug({ run_id: runId, count: result.changes }, 'running fanout_items reset');
  return result.changes;
}

/** Counts by status. Every key present, zero when none. */
export function countFanOutItems(runId: string): Record<FanOutItemStatusValue, number> {
  const counts: Record<FanOutItemStatusValue, number> = {
    pending: 0,
    running: 0,
    done: 0,
    dead: 0,
  };
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM fanout_items WHERE run_id = ? GROUP BY status`)
    .all(runId) as Array<{ status: FanOutItemStatusValue; n: number }>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}
