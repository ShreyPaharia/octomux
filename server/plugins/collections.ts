/**
 * `ctx.collections` — durable, keyed, schema-validated records (SHR-275).
 *
 * The half of plugin storage `ctx.facts` deliberately isn't. Facts are an
 * append-only log scoped to one task and deleted with it; a collection is a
 * set of records keyed by a field the plugin nominates, upserted on write,
 * with no task in the picture. Every `ctx.ui.panel()` binding that could
 * exist before this one was fact-bound, therefore task-scoped, therefore
 * unable to render anything durable — unstranding that shipped UI layer is
 * the point of this module as much as the storage is.
 *
 * Names are qualified `<pluginId>:<name>` by `qualify()`, exactly like fact
 * types, so a plugin can never claim a `core:` name or overwrite a sibling's.
 *
 * NOT `ctx.kv` (SHR-263): kv is opaque blobs keyed by a string; this is
 * schema-validated queryable records. They may share a storage layer one day;
 * they are not the same API.
 *
 * SIGNATURES ARE PINNED. Fill in bodies and add tests; do not change an
 * exported shape.
 */
import type { CollectionDefinition, QuerySpec } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { qualify } from './qualify.js';
import { forgetCompiledSchema, validateAgainstSchema } from '../services/output-contract.js';
import { queryRecords, upsertRecord } from '../repositories/plugin-collections.js';

const logger = childLogger('plugins/collections');

interface CollectionRegistration {
  pluginId: string;
  schema: Record<string, unknown>;
  key: string;
}

/** Qualified name -> its registration. */
const definitions = new Map<string, CollectionRegistration>();

/** Qualified name -> listeners subscribed via `watch`. */
const watchers = new Map<string, Set<(record: unknown) => void>>();

/**
 * Declares a collection. `def.name` is BARE; this qualifies it.
 *
 * Rejects a `core:` name (reserved wholesale, same as fact types), a
 * duplicate definition, and a `key` that isn't a non-empty string.
 */
export function defineCollection(pluginId: string, def: CollectionDefinition): void {
  const qualified = qualify(pluginId, def.name);
  if (qualified.startsWith('core:')) {
    throw new Error(`plugin "${pluginId}": cannot define a "core:" collection ("${qualified}")`);
  }
  if (definitions.has(qualified)) {
    throw new Error(`plugin "${pluginId}": collection "${qualified}" is already defined`);
  }
  if (typeof def.key !== 'string' || def.key.length === 0) {
    throw new Error(`plugin "${pluginId}": collection "${qualified}" needs a non-empty "key"`);
  }
  definitions.set(qualified, { pluginId, schema: def.schema, key: def.key });
}

/**
 * Upserts a record. `localName` is BARE — a plugin writes only its own
 * collections, so a name containing `:` is rejected rather than treated as a
 * cross-plugin write (out of scope for SHR-275).
 *
 * Validates against the definition's schema, then extracts the key field.
 * A missing key, or one that is not a string/number, is rejected with an
 * error naming the plugin, the collection, and the key field.
 */
export async function putRecord(
  pluginId: string,
  localName: string,
  record: unknown,
): Promise<void> {
  if (localName.includes(':')) {
    throw new Error(
      `plugin "${pluginId}": ctx.collections.put() takes a bare local name, not "${localName}" — ` +
        `writing another plugin's collection is out of scope for SHR-275`,
    );
  }

  const qualified = qualify(pluginId, localName);
  const def = definitions.get(qualified);
  if (!def) {
    throw new Error(
      `plugin "${pluginId}": collection "${qualified}" is not defined — call ctx.collections.define() first`,
    );
  }

  const result = validateAgainstSchema(qualified, def.schema, record);
  if (!result.valid) {
    const detail = (result.errors ?? []).join('; ') || 'invalid payload';
    childLogger(`plugin:${pluginId}`).warn(
      { collection: qualified, errors: result.errors },
      'collection record rejected: schema violation',
    );
    throw new Error(
      `plugin "${pluginId}": collection "${qualified}" record failed schema validation: ${detail}`,
    );
  }

  const keyValue =
    record !== null && typeof record === 'object'
      ? (record as Record<string, unknown>)[def.key]
      : undefined;
  if (keyValue === undefined) {
    throw new Error(
      `plugin "${pluginId}": collection "${qualified}" record is missing its key field "${def.key}"`,
    );
  }
  const isValidKey =
    typeof keyValue === 'string' || (typeof keyValue === 'number' && Number.isFinite(keyValue));
  if (!isValidKey) {
    throw new Error(
      `plugin "${pluginId}": collection "${qualified}" key field "${def.key}" must be a string ` +
        `or number, got ${typeof keyValue}`,
    );
  }

  const stored = upsertRecord(qualified, String(keyValue), record);
  notifyWatchers(qualified, stored.record);
}

/**
 * Reads records. `name` may be BARE (resolved against `pluginId`) or already
 * QUALIFIED — reads are unscoped, same as `readFacts`. Returns the bare
 * record values, not the storage envelope.
 */
export async function queryCollection(
  pluginId: string,
  name: string,
  q?: QuerySpec,
): Promise<unknown[]> {
  const qualified = name.includes(':') ? name : qualify(pluginId, name);
  return queryRecords(qualified, q).map((r) => r.record);
}

/** Subscribes to a QUALIFIED collection name. In-process emitter fired on
 *  write — never a DB poll. Returns an unsubscribe. */
export function watchCollection(
  qualifiedName: string,
  onRecord: (record: unknown) => void,
): () => void {
  let set = watchers.get(qualifiedName);
  if (!set) {
    set = new Set();
    watchers.set(qualifiedName, set);
  }
  set.add(onRecord);
  return () => {
    set?.delete(onRecord);
  };
}

/** Qualified names a plugin defined. For `ctx.catalog` / unmount accounting. */
export function listPluginCollections(pluginId: string): string[] {
  const result: string[] = [];
  for (const [qualified, def] of definitions) {
    if (def.pluginId === pluginId) result.push(qualified);
  }
  return result;
}

/** Whether a QUALIFIED name has a live `define()` registration. Used by
 *  `ui-registry.ts` to warn on a `ctx.ui.panel({ collection })` typo. */
export function isCollectionDefined(qualifiedName: string): boolean {
  return definitions.has(qualifiedName);
}

function notifyWatchers(qualifiedName: string, record: unknown): void {
  for (const listener of watchers.get(qualifiedName) ?? []) {
    try {
      listener(record);
    } catch (err) {
      logger.warn({ name: qualifiedName, err }, 'collection watcher threw');
    }
  }
}

/**
 * Drops a plugin's collection DEFINITIONS on unmount. Deliberately does NOT
 * delete stored rows: a collection is durable, and a hot reload (SHR-254)
 * re-runs `apply()` moments later expecting its records still there. Busts
 * the ajv cache for each name for the same reason `unregisterPluginFacts`
 * does — a reload may redefine the same qualified name with a different
 * schema. Watchers are left alone: a watcher's lifecycle belongs to the
 * plugin that REGISTERED it (released via that plugin's `ctx.effect` stack),
 * not to the one that defined the name.
 */
export function unregisterPluginCollections(pluginId: string): void {
  for (const [qualified, def] of definitions) {
    if (def.pluginId !== pluginId) continue;
    definitions.delete(qualified);
    forgetCompiledSchema(qualified);
  }
}

/** Test-only: clears definitions and watchers. */
export function resetCollections(): void {
  definitions.clear();
  watchers.clear();
}
