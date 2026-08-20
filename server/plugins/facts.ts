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

const notImplemented = (what: string): never => {
  throw new Error(`${what}: not implemented — SHR-255 (task B) owns this module`);
};

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

/** Declares a fact type. `def.type` is BARE; this qualifies to `<pluginId>:<type>`. */
export function defineFactType(_pluginId: string, _def: FactTypeDefinition): void {
  notImplemented('defineFactType');
}

/** Appends a fact. Validates against the type's schema; a violation is rejected
 *  with a clean error naming the plugin and logged against it. */
export function putFact(
  _pluginId: string,
  _taskId: string,
  _localType: string,
  _payload: unknown,
): Promise<void> {
  return notImplemented('putFact');
}

/** Reads facts for a task. `opts.type` is QUALIFIED. */
export function readFacts(_taskId: string, _opts?: FactQuery): Promise<Fact[]> {
  return notImplemented('readFacts');
}

/** Subscribes to a QUALIFIED fact type. In-process emitter fired on write —
 *  never a DB poll. Returns an unsubscribe. */
export function watchFacts(_qualifiedType: string, _onFact: (fact: Fact) => void): () => void {
  return notImplemented('watchFacts');
}

/** Publishes a core fact. `qualifiedType` must be one of `CORE_FACT_TYPES`. */
export function putCoreFact(
  _taskId: string,
  _qualifiedType: string,
  _payload: unknown,
): Promise<void> {
  return notImplemented('putCoreFact');
}

/** Drops a plugin's fact-type definitions and watchers. Called on unmount.
 *  Does NOT delete already-written facts — those die with their task. */
export function unregisterPluginFacts(_pluginId: string): void {
  notImplemented('unregisterPluginFacts');
}

/** Test-only: clears definitions and watchers. */
export function resetFacts(): void {
  notImplemented('resetFacts');
}
