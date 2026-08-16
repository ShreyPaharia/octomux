import type { Harness } from './types.js';
import { childLogger } from '../logger.js';

const logger = childLogger('harnesses/registry');

const harnesses = new Map<string, Harness>();

export const DEFAULT_HARNESS_ID = 'claude-code';

/** The harness ids octomux ships. Plugins may not redefine these. */
export const CORE_HARNESS_IDS = ['claude-code', 'cursor'] as const;

let frozen = false;

export function registerHarness(h: Harness): void {
  // Check the freeze guard first: it's the more specific diagnostic, and in
  // the real boot sequence (both core harnesses register, then
  // freezeCoreHarnesses() runs) a core id is always ALSO a duplicate by the
  // time a plugin can reach this function — so if the duplicate check ran
  // first it would win every time and this branch would never fire.
  if (frozen && (CORE_HARNESS_IDS as readonly string[]).includes(h.id)) {
    logger.warn({ harness_id: h.id }, 'refusing to redefine core harness after freeze');
    return;
  }
  if (harnesses.has(h.id)) {
    // ponytail: warn-only so a bad upgrade can't brick boot; make fatal in 2.0.
    logger.warn({ harness_id: h.id }, 'harness already registered, keeping first registration');
    return;
  }
  harnesses.set(h.id, h);
}

/**
 * Locks the core harness ids against redefinition. Call once at boot, after
 * `claude-code` and `cursor` have registered and before any plugin loads.
 */
export function freezeCoreHarnesses(): void {
  frozen = true;
}

/** Test-only: clears the registry and unfreezes it. */
export function resetHarnesses(): void {
  harnesses.clear();
  frozen = false;
}

export function getHarness(id: string | null | undefined): Harness {
  const key = id ?? DEFAULT_HARNESS_ID;
  const h = harnesses.get(key);
  if (!h) throw new Error(`Unknown harness: ${key}`);
  return h;
}

export function listHarnesses(): Harness[] {
  return Array.from(harnesses.values());
}
