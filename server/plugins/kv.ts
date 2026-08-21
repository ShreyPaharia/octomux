/**
 * `ctx.kv` — durable, plugin-PRIVATE scratch storage (SHR-263).
 *
 * Opaque blobs keyed by a string, scoped to the plugin that wrote them.
 * Nobody but the owning plugin can read a kv entry — every function here
 * takes the caller's own `pluginId` and the repository underneath scopes
 * every query to it, so there is no cross-plugin read path at all.
 *
 * NOT `ctx.collections`: a collection is schema-validated, keyed on a field
 * the plugin nominates, and its reads are unscoped (`query` takes a bare OR
 * qualified name — any plugin may read any collection). kv has no schema,
 * no query language beyond a key or a key prefix, and no cross-plugin read.
 * They may end up sharing a storage layer one day; they are not the same
 * API and were given their own table (`plugin_kv`), not
 * `plugin_collections` with a nullable schema — same reasoning as ruling R1
 * that split `plugin_facts` from `plugin_collections` in the first place.
 *
 * kv state deliberately OUTLIVES an unmount. `unregisterPluginCollections` /
 * `unregisterPluginFacts` drop DEFINITIONS on unmount but never rows, and kv
 * goes further still: there is no unmount hook here at all, not even for
 * definitions, because kv has none. A hot-reloaded or restarted plugin must
 * find its state — ordinary or in-flight — exactly where it left it.
 *
 * `kvBegin`/`kvEnd`/`kvInterrupted` are the crash-recovery half of this
 * module. `begin` stamps a row's `owner` column with the caller's mount id;
 * `end` clears it by deleting the row. `interrupted` lists rows stamped by
 * some OTHER mount — by construction, an operation that never called `end`,
 * because the process crashed or a hot reload tore that mount down first.
 * A plain `set`/`kvSet` on a key also settles any in-flight mark on it
 * (`putKvEntry`'s `owner` defaults to `null`), so a plugin that decides to
 * just overwrite a checkpoint rather than resume it clears the mark for
 * free.
 *
 * Free functions, ungated — grant checks live in `context.ts`, same
 * convention as `collections.ts` and `fanout.ts`: every capability check in
 * the plugin runtime lives in one file.
 */
import { childLogger } from '../logger.js';
import {
  getKvEntry,
  putKvEntry,
  deleteKvEntry,
  listKvEntries,
  listKvEntriesOwnedByOthers,
} from '../repositories/plugin-kv.js';

const logger = childLogger('plugins/kv');

function requireKey(pluginId: string, key: unknown, what: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`plugin "${pluginId}": ctx.kv.${what}() requires a non-empty string key`);
  }
  return key;
}

export function kvGet(pluginId: string, key: string): unknown | undefined {
  requireKey(pluginId, key, 'get');
  return getKvEntry(pluginId, key)?.value;
}

/** Plain write. Settles any in-flight mark left on this key by `kvBegin`. */
export function kvSet(pluginId: string, key: string, value: unknown): void {
  requireKey(pluginId, key, 'set');
  putKvEntry(pluginId, key, value, null);
  logger.debug({ plugin_id: pluginId, key }, 'kv set');
}

export function kvDel(pluginId: string, key: string): void {
  requireKey(pluginId, key, 'del');
  deleteKvEntry(pluginId, key);
  logger.debug({ plugin_id: pluginId, key }, 'kv del');
}

export function kvList(pluginId: string, prefix?: string): Array<{ key: string; value: unknown }> {
  return listKvEntries(pluginId, prefix).map((e) => ({ key: e.key, value: e.value }));
}

/** Marks an operation in flight under `mountId`. Same key space as `kvSet`. */
export function kvBegin(pluginId: string, mountId: string, key: string, value: unknown): void {
  requireKey(pluginId, key, 'begin');
  putKvEntry(pluginId, key, value, mountId);
  logger.debug({ plugin_id: pluginId, key, mount_id: mountId }, 'kv begin (in-flight mark set)');
}

/** The operation finished. Deletes the checkpoint row entirely. */
export function kvEnd(pluginId: string, key: string): void {
  requireKey(pluginId, key, 'end');
  deleteKvEntry(pluginId, key);
  logger.debug({ plugin_id: pluginId, key }, 'kv end (checkpoint cleared)');
}

/** Checkpoints stamped by any mount other than `mountId` — crash-recovery
 *  candidates for this boot. */
export function kvInterrupted(
  pluginId: string,
  mountId: string,
): Array<{ key: string; value: unknown; startedAt: string }> {
  return listKvEntriesOwnedByOthers(pluginId, mountId).map((e) => ({
    key: e.key,
    value: e.value,
    startedAt: e.updatedAt,
  }));
}
