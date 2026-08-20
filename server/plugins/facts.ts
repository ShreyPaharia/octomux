/**
 * `ctx.facts` — the typed, task-scoped, append-only fact log shared across
 * plugin types. The core primitive of the plugin runtime: `ctx.ui`,
 * `ctx.policy` and `ctx.attention` are all consumers of it.
 *
 * Before this, the only wire between plugin types was `HookEnvelope
 * { event, task, data }` — seven fixed event names, task-shaped, outbound only
 * and fire-and-forget, with no read path at all. A workflow could not read a
 * harness's output; an integration could not see what a workflow produced.
 *
 * NOT the `events` table. That one is the orchestrator's control bus: written
 * by `repositories/orchestrator.ts`, drained by `SELECT * FROM events WHERE
 * seq > ?` with `managed_tasks.last_event_seq` as the cursor. Sharing it would
 * put plugin facts into the conductor's drain and share one AUTOINCREMENT seq
 * between control events and observation facts. Facts get their own
 * `plugin_facts` table (ruling R1 in the P0 plan).
 *
 * SIGNATURES ARE PINNED (plans/2026-08-20-plugin-runtime-p0.md STEP-0).
 * Task B fills in the bodies; nothing here may change shape.
 */
import type { Fact, FactQuery, FactTypeDefinition } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { qualify } from './qualify.js';
import { forgetCompiledSchema, validateAgainstSchema } from '../services/output-contract.js';
import { insertFact, readFactsForTask } from '../repositories/plugin-facts.js';

const logger = childLogger('plugins/facts');

/**
 * Fact types core owns. A plugin can never define or write one of these —
 * they are published by core and read by plugins.
 */
export const CORE_FACT_TYPES = [
  'core:diff',
  'core:tests.passed',
  'core:review.published',
  'core:pr.opened',
] as const;

interface FactTypeRegistration {
  pluginId: string;
  schema: Record<string, unknown>;
}

/** Qualified type -> its registration. */
const definitions = new Map<string, FactTypeRegistration>();

/** Qualified type -> listeners subscribed via `watch`. */
const watchers = new Map<string, Set<(fact: Fact) => void>>();

/** Declares a fact type. `def.type` is BARE; this qualifies to `<pluginId>:<type>`. */
export function defineFactType(pluginId: string, def: FactTypeDefinition): void {
  const qualified = qualify(pluginId, def.type);
  if (qualified.startsWith('core:')) {
    throw new Error(`plugin "${pluginId}": cannot define a "core:" fact type ("${qualified}")`);
  }
  if (definitions.has(qualified)) {
    throw new Error(`plugin "${pluginId}": fact type "${qualified}" is already defined`);
  }
  definitions.set(qualified, { pluginId, schema: def.schema });
}

/** Appends a fact. Validates against the type's schema; a violation is rejected
 *  with a clean error naming the plugin and logged against it. */
export async function putFact(
  pluginId: string,
  taskId: string,
  localType: string,
  payload: unknown,
): Promise<void> {
  const qualified = qualify(pluginId, localType);
  const def = definitions.get(qualified);
  if (!def) {
    throw new Error(
      `plugin "${pluginId}": fact type "${qualified}" is not defined — call ctx.facts.define() first`,
    );
  }

  const result = validateAgainstSchema(qualified, def.schema, payload);
  if (!result.valid) {
    const detail = (result.errors ?? []).join('; ') || 'invalid payload';
    childLogger(`plugin:${pluginId}`).warn(
      { task_id: taskId, type: qualified, errors: result.errors },
      'fact rejected: schema violation',
    );
    throw new Error(
      `plugin "${pluginId}": fact "${qualified}" failed schema validation: ${detail}`,
    );
  }

  const fact = insertFact(taskId, qualified, payload);
  notifyWatchers(qualified, fact);
}

/** Reads facts for a task. `opts.type` is QUALIFIED. */
export async function readFacts(taskId: string, opts?: FactQuery): Promise<Fact[]> {
  return readFactsForTask(taskId, opts);
}

/** Subscribes to a QUALIFIED fact type. In-process emitter fired on write —
 *  never a DB poll. Returns an unsubscribe. */
export function watchFacts(qualifiedType: string, onFact: (fact: Fact) => void): () => void {
  let set = watchers.get(qualifiedType);
  if (!set) {
    set = new Set();
    watchers.set(qualifiedType, set);
  }
  set.add(onFact);
  return () => {
    set?.delete(onFact);
  };
}

/** Publishes a core fact. `qualifiedType` must be one of `CORE_FACT_TYPES`. */
export async function putCoreFact(
  taskId: string,
  qualifiedType: string,
  payload: unknown,
): Promise<void> {
  if (!(CORE_FACT_TYPES as readonly string[]).includes(qualifiedType)) {
    throw new Error(`putCoreFact: "${qualifiedType}" is not a registered core fact type`);
  }
  const fact = insertFact(taskId, qualifiedType, payload);
  notifyWatchers(qualifiedType, fact);
}

function notifyWatchers(qualifiedType: string, fact: Fact): void {
  for (const listener of watchers.get(qualifiedType) ?? []) {
    try {
      listener(fact);
    } catch (err) {
      logger.warn({ type: qualifiedType, err }, 'fact watcher threw');
    }
  }
}

/** Drops a plugin's fact-type definitions and watchers. Called on unmount.
 *  Does NOT delete already-written facts — those die with their task. */
export function unregisterPluginFacts(pluginId: string): void {
  for (const [qualified, def] of definitions) {
    if (def.pluginId !== pluginId) continue;
    definitions.delete(qualified);
    // Drops watchers on this type registered by ANY plugin, not just this one.
    // That is deliberate: the type's only writer is going away, so no further
    // fact of this type can ever arrive and every watcher on it is already
    // dead. A watcher this plugin placed on somebody ELSE's type is released
    // separately, by the effect stack in `context.ts` — see the note there.
    watchers.delete(qualified);
    // The ajv cache in `output-contract.ts` is keyed on the type string alone
    // and never notices a schema change. Reload (SHR-254) re-runs apply(),
    // which may redefine this same qualified type with a DIFFERENT schema;
    // without this bust, every later write would validate against the old
    // schema silently, with no error and no log.
    forgetCompiledSchema(qualified);
  }
}

/** Test-only: clears definitions and watchers. */
export function resetFacts(): void {
  definitions.clear();
  watchers.clear();
}
