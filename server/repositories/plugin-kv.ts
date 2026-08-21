/**
 * Repository for `plugin_kv` — the durable, plugin-PRIVATE scratch store
 * behind `ctx.kv`.
 *
 * Its OWN table, not `plugin_collections` with a nullable schema: kv is
 * opaque blobs keyed by a string, never validated, never queryable beyond an
 * exact key or a key prefix, and never readable by another plugin. A
 * collection is schema-validated and unscoped for reads; kv is neither. Same
 * reasoning as ruling R1 that split `plugin_facts` from `plugin_collections`
 * in the first place.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/plugin-kv');

export interface KvEntry {
  pluginId: string;
  key: string;
  value: unknown;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PluginKvRow {
  plugin_id: string;
  key: string;
  value: string;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: PluginKvRow): KvEntry {
  return {
    pluginId: row.plugin_id,
    key: row.key,
    value: JSON.parse(row.value),
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escapes `\`, `%`, and `_` so a caller-supplied prefix is matched literally
 *  under `LIKE ... ESCAPE '\'` — a prefix containing `%` must not act as a
 *  wildcard. */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One entry by exact key, or undefined. */
export function getKvEntry(pluginId: string, key: string): KvEntry | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM plugin_kv WHERE plugin_id = ? AND key = ?`)
    .get(pluginId, key) as PluginKvRow | undefined;
  return row ? toEntry(row) : undefined;
}

/** Upsert on (plugin_id, key). `owner` defaults to null — a plain write settles
 *  any in-flight mark on that key. */
export function putKvEntry(
  pluginId: string,
  key: string,
  value: unknown,
  owner: string | null = null,
): KvEntry {
  getDb()
    .prepare(
      `INSERT INTO plugin_kv (plugin_id, key, value, owner) VALUES (?, ?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET
         value = excluded.value, owner = excluded.owner, updated_at = datetime('now')`,
    )
    .run(pluginId, key, JSON.stringify(value ?? null), owner);
  logger.debug({ plugin_id: pluginId, key, owner }, 'plugin kv entry upserted');
  return getKvEntry(pluginId, key)!;
}

/** Returns whether a row was removed. */
export function deleteKvEntry(pluginId: string, key: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?`)
    .run(pluginId, key);
  return result.changes > 0;
}

/** Every entry for a plugin, optionally narrowed to a key prefix. Ordered by key ASC. */
export function listKvEntries(pluginId: string, prefix?: string): KvEntry[] {
  const conditions = ['plugin_id = ?'];
  const params: Array<string> = [pluginId];

  if (prefix !== undefined) {
    conditions.push(`key LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLikePrefix(prefix)}%`);
  }

  const rows = getDb()
    .prepare(`SELECT * FROM plugin_kv WHERE ${conditions.join(' AND ')} ORDER BY key ASC`)
    .all(...params) as PluginKvRow[];
  return rows.map(toEntry);
}

/** Entries left in flight by some OTHER mount: `owner IS NOT NULL AND owner <> ?`.
 *  Ordered by key ASC. */
export function listKvEntriesOwnedByOthers(pluginId: string, owner: string): KvEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM plugin_kv
       WHERE plugin_id = ? AND owner IS NOT NULL AND owner <> ?
       ORDER BY key ASC`,
    )
    .all(pluginId, owner) as PluginKvRow[];
  return rows.map(toEntry);
}

/** Deletes every entry for a plugin. Explicit purge path + tests only — this is
 *  NOT called on unmount; kv state deliberately outlives the plugin. */
export function deletePluginKv(pluginId: string): number {
  const result = getDb().prepare(`DELETE FROM plugin_kv WHERE plugin_id = ?`).run(pluginId);
  logger.info({ plugin_id: pluginId, deleted: result.changes }, 'plugin kv purged');
  return result.changes;
}
