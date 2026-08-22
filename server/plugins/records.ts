/**
 * `ctx.records` — the single store for plugin data (SHR-282), replacing three
 * prior storage APIs and their three tables. One `RecordStoreDefinition`
 * shape covers all three prior lifetimes: `scope` picks task-scoped vs
 * durable, `mode` picks append-only vs upsert-on-key, and an opaque store
 * with no `schema` recovers the old plugin-private blob store.
 */
import type { RecordEnvelope, RecordStoreDefinition, QuerySpec } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { qualify } from './qualify.js';
import { forgetCompiledSchema, validateAgainstSchema } from '../services/output-contract.js';
import {
  appendRecord,
  upsertRecord,
  readRecordsForTask,
  queryRecords,
  markInFlight,
  clearInFlight,
  listInFlightOwnedByOthers,
  type RecordRow,
} from '../repositories/plugin-records.js';

const logger = childLogger('plugins/records');

/**
 * Record stores core owns. Published via `publishCoreRecord` from
 * `server/plugins/policy.ts` and `server/workflows/reviewer/publish-review.ts` —
 * core writes, plugins only read or watch.
 */
export const CORE_RECORD_STORES = ['core:review.published', 'core:policy.decision'] as const;

interface StoreRegistration extends RecordStoreDefinition {
  pluginId: string;
}

/** Qualified store name -> its registration. */
const definitions = new Map<string, StoreRegistration>();

/** Qualified store name -> listeners subscribed via `watch`. */
const watchers = new Map<string, Set<(rec: RecordEnvelope) => void>>();

/** Exported for `server/surfaces/render.ts` and `server/routes/plugin-records.ts` —
 *  both read `RecordRow`s straight from the repository (unscoped, no
 *  `pluginId` at hand) and need the same row -> wire-shape conversion this
 *  module already does for every `ctx.records` call. */
export function toEnvelope(row: RecordRow): RecordEnvelope {
  return {
    seq: row.seq,
    store: row.store,
    taskId: row.taskId,
    key: row.key,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notifyWatchers(qualified: string, envelope: RecordEnvelope): void {
  for (const listener of watchers.get(qualified) ?? []) {
    try {
      listener(envelope);
    } catch (err) {
      logger.warn({ store: qualified, err }, 'record watcher threw');
    }
  }
}

function requireKey(pluginId: string, key: unknown, what: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`plugin "${pluginId}": ctx.records.${what}() requires a non-empty string key`);
  }
  return key;
}

/**
 * Declares a store. `def.name` is BARE; this qualifies it.
 *
 * Rejects a `core:` name (reserved wholesale — core stores are published by
 * core, never defined via `ctx.records`), a duplicate definition, and the
 * two invalid combinations: `mode:'append'` with a `key`, and `mode:'upsert'`
 * without one.
 */
export function defineStore(pluginId: string, def: RecordStoreDefinition): void {
  const qualified = qualify(pluginId, def.name);
  if (qualified.startsWith('core:')) {
    throw new Error(`plugin "${pluginId}": cannot define a "core:" record store ("${qualified}")`);
  }
  if (definitions.has(qualified)) {
    throw new Error(`plugin "${pluginId}": record store "${qualified}" is already defined`);
  }
  if (def.mode === 'append' && def.key !== undefined) {
    throw new Error(
      `plugin "${pluginId}": record store "${qualified}" is mode 'append' and cannot declare a "key"`,
    );
  }
  if (def.mode === 'upsert' && def.key === undefined) {
    throw new Error(
      `plugin "${pluginId}": record store "${qualified}" is mode 'upsert' and requires a "key"`,
    );
  }
  definitions.set(qualified, { ...def, pluginId });
}

/**
 * Writes a record. `name` is BARE — a plugin writes only its own stores; a
 * name containing `:` is rejected rather than treated as a cross-plugin write.
 *
 * Validates scope against `taskId`, then the payload against the store's
 * schema (if any), then — for `mode:'upsert'` — extracts and validates the
 * key field before delegating to the repository's append or upsert.
 */
export async function putRecord(
  pluginId: string,
  name: string,
  record: unknown,
  taskId?: string,
): Promise<void> {
  if (name.includes(':')) {
    throw new Error(
      `plugin "${pluginId}": ctx.records.put() takes a bare local name, not "${name}" — ` +
        `writing another plugin's store is out of scope`,
    );
  }

  const qualified = qualify(pluginId, name);
  const def = definitions.get(qualified);
  if (!def) {
    throw new Error(
      `plugin "${pluginId}": record store "${qualified}" is not defined — call ctx.records.define() first`,
    );
  }

  if (def.scope === 'durable' && taskId !== undefined) {
    throw new Error(
      `plugin "${pluginId}": record store "${qualified}" is durable and cannot take a taskId`,
    );
  }
  if (def.scope === 'task' && taskId === undefined) {
    throw new Error(
      `plugin "${pluginId}": record store "${qualified}" is task-scoped and requires a taskId`,
    );
  }

  if (def.schema) {
    const result = validateAgainstSchema(qualified, def.schema, record);
    if (!result.valid) {
      const detail = (result.errors ?? []).join('; ') || 'invalid payload';
      childLogger(`plugin:${pluginId}`).warn(
        { store: qualified, errors: result.errors },
        'record rejected: schema violation',
      );
      throw new Error(
        `plugin "${pluginId}": record store "${qualified}" record failed schema validation: ${detail}`,
      );
    }
  }

  let row: RecordRow;
  if (def.mode === 'upsert') {
    const keyValue =
      record !== null && typeof record === 'object'
        ? (record as Record<string, unknown>)[def.key as string]
        : undefined;
    if (keyValue === undefined) {
      throw new Error(
        `plugin "${pluginId}": record store "${qualified}" record is missing its key field "${def.key}"`,
      );
    }
    const isValidKey =
      typeof keyValue === 'string' || (typeof keyValue === 'number' && Number.isFinite(keyValue));
    if (!isValidKey) {
      throw new Error(
        `plugin "${pluginId}": record store "${qualified}" key field "${def.key}" must be a string ` +
          `or number, got ${typeof keyValue}`,
      );
    }
    row = upsertRecord(qualified, taskId ?? null, String(keyValue), record);
  } else {
    row = appendRecord(qualified, taskId ?? null, record);
  }

  notifyWatchers(qualified, toEnvelope(row));
}

/** Reads every row written for a task, scoped to one store. `name` is BARE. */
export async function readStore(
  pluginId: string,
  name: string,
  taskId: string,
): Promise<RecordEnvelope[]> {
  const qualified = qualify(pluginId, name);
  return readRecordsForTask(taskId, qualified).map(toEnvelope);
}

/**
 * Queries a store. `name` may be BARE (resolved against `pluginId`) or
 * already QUALIFIED — reads are unscoped.
 */
export async function queryStore(
  pluginId: string,
  name: string,
  q?: QuerySpec,
): Promise<RecordEnvelope[]> {
  const qualified = name.includes(':') ? name : qualify(pluginId, name);
  return queryRecords(qualified, q).map(toEnvelope);
}

/** Subscribes to a QUALIFIED store. In-process emitter fired on write — never
 *  a DB poll. Returns an unsubscribe. `watcherId` is for logging only: a
 *  watcher's lifecycle belongs to the WATCHING plugin's own effect stack, not
 *  to whichever plugin defines the store. */
export function watchStore(
  watcherId: string,
  qualified: string,
  cb: (r: RecordEnvelope) => void,
): () => void {
  let set = watchers.get(qualified);
  if (!set) {
    set = new Set();
    watchers.set(qualified, set);
  }
  set.add(cb);
  logger.debug({ watcher: watcherId, store: qualified }, 'record watcher registered');
  return () => {
    set?.delete(cb);
  };
}

/** Marks an operation in flight under `mountId`. Checkpoints are scoped per
 *  store (`name` required): one plugin can own several stores, and a flat
 *  per-plugin checkpoint key would let two of them collide. */
export function beginCheckpoint(
  pluginId: string,
  name: string,
  key: string,
  value: unknown,
  mountId: string,
): void {
  requireKey(pluginId, key, 'begin');
  const qualified = qualify(pluginId, name);
  markInFlight(qualified, key, value, mountId);
  logger.debug(
    { plugin_id: pluginId, store: qualified, key, mount_id: mountId },
    'checkpoint begin',
  );
}

/** The operation finished. Settles the checkpoint without changing the
 *  underlying record's payload. */
export function endCheckpoint(pluginId: string, name: string, key: string): void {
  requireKey(pluginId, key, 'end');
  const qualified = qualify(pluginId, name);
  clearInFlight(qualified, key);
  logger.debug({ plugin_id: pluginId, store: qualified, key }, 'checkpoint end');
}

/** Checkpoints left by some OTHER mount — by construction, work that never
 *  finished. `name` scopes to one store; omitted, every store this plugin
 *  owns. */
export function interruptedFor(pluginId: string, mountId: string, name?: string): RecordEnvelope[] {
  const stores = name !== undefined ? [qualify(pluginId, name)] : listPluginStores(pluginId);
  return listInFlightOwnedByOthers(stores, mountId).map(toEnvelope);
}

/**
 * Definition lifetime follows ROW lifetime. Task-scoped rows die with their
 * task, so their definitions drop on unmount. Durable rows outlive unmount, so
 * their definitions must too — a durable store whose rows survive but whose
 * definition vanished would be unreadable.
 */
export function unregisterTaskScopedStores(pluginId: string): string[] {
  const dropped: string[] = [];
  for (const [qualified, def] of definitions) {
    if (def.pluginId !== pluginId || def.scope !== 'task') continue;
    definitions.delete(qualified);
    if (def.schema) forgetCompiledSchema(qualified);
    dropped.push(qualified);
  }
  return dropped;
}

/** Qualified store names a plugin defined (task-scoped and durable alike).
 *  For `ctx.catalog` / unmount accounting / checkpoint scoping. */
export function listPluginStores(pluginId: string): string[] {
  const result: string[] = [];
  for (const [qualified, def] of definitions) {
    if (def.pluginId === pluginId) result.push(qualified);
  }
  return result;
}

/** Whether a QUALIFIED store has a live `define()` registration. Used by
 *  `ui-registry.ts` to warn on a `ctx.ui.panel({ record })` typo. */
export function isStoreDefined(qualified: string): boolean {
  return definitions.has(qualified);
}

/** Publishes a core record. `qualifiedStore` must be one of
 *  `CORE_RECORD_STORES` — core stores are published by core and read by
 *  plugins, never defined or written via `ctx.records`. */
export function publishCoreRecord(qualifiedStore: string, taskId: string, payload: unknown): void {
  if (!(CORE_RECORD_STORES as readonly string[]).includes(qualifiedStore)) {
    throw new Error(`publishCoreRecord: "${qualifiedStore}" is not a registered core record store`);
  }
  const row = appendRecord(qualifiedStore, taskId, payload);
  notifyWatchers(qualifiedStore, toEnvelope(row));
}

/** Test-only: clears definitions and watchers. */
export function resetRecords(): void {
  definitions.clear();
  watchers.clear();
}
