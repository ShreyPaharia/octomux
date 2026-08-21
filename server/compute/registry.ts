import type { ComputeProvider } from './types.js';
import { childLogger } from '../logger.js';

const logger = childLogger('compute/registry');

const providers = new Map<string, ComputeProvider>();

export const DEFAULT_COMPUTE_KIND = 'local';

/** The compute kinds octomux ships. Plugins may not redefine these. */
export const CORE_COMPUTE_KINDS = ['local'] as const;

let frozen = false;

export function registerCompute(p: ComputeProvider): void {
  // Check the freeze guard first: it's the more specific diagnostic, and in
  // the real boot sequence (core compute registers, then freezeCoreCompute()
  // runs) a core kind is always ALSO a duplicate by the time a plugin can
  // reach this function — so if the duplicate check ran first it would win
  // every time and this branch would never fire.
  if (frozen && (CORE_COMPUTE_KINDS as readonly string[]).includes(p.kind)) {
    logger.warn(
      { compute_kind: p.kind },
      'refusing to redefine core compute provider after freeze',
    );
    return;
  }
  if (providers.has(p.kind)) {
    // ponytail: warn-only so a bad upgrade can't brick boot; make fatal in 2.0.
    logger.warn(
      { compute_kind: p.kind },
      'compute provider already registered, keeping first registration',
    );
    return;
  }
  providers.set(p.kind, p);
}

/**
 * Locks the core compute kinds against redefinition. Call once at boot,
 * after `local` has registered and before any plugin loads.
 */
export function freezeCoreCompute(): void {
  frozen = true;
}

/** Test-only: clears the registry and unfreezes it. */
export function resetCompute(): void {
  providers.clear();
  frozen = false;
}

/** Removes one plugin-registered compute provider. Refuses (logs a warn,
 *  no-op) on any `CORE_COMPUTE_KINDS` member — core providers are
 *  un-unregisterable. */
export function unregisterCompute(kind: string): boolean {
  if ((CORE_COMPUTE_KINDS as readonly string[]).includes(kind)) {
    logger.warn({ compute_kind: kind }, 'refusing to unregister core compute provider');
    return false;
  }
  return providers.delete(kind);
}

export function getCompute(kind: string | null | undefined): ComputeProvider {
  const key = kind ?? DEFAULT_COMPUTE_KIND;
  const p = providers.get(key);
  if (!p) throw new Error(`Unknown compute provider: ${key}`);
  return p;
}

export function listCompute(): ComputeProvider[] {
  return Array.from(providers.values());
}
