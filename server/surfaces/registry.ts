/**
 * server/surfaces/registry.ts
 *
 * `ctx.surfaces` — the registry backing `SurfaceRegistrar` (`@octomux/plugin-api`).
 * Mirrors `server/compute/registry.ts`'s register/freeze/reset shape exactly:
 * warn-and-keep-first on a duplicate kind, warn-and-refuse on a core kind
 * registered (or unregistered) after `freezeCoreSurfaces()` runs.
 *
 * Keyed by `SurfaceDefinition.kind` as given — the caller (the plugin
 * registrar in `server/plugins/context.ts`) already qualifies a plugin
 * surface's kind to `<pluginId>:<kind>` before it reaches here, same as
 * every other registrar.
 */
import type { SurfaceDefinition } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';

const logger = childLogger('surfaces/registry');

const surfaces = new Map<string, SurfaceDefinition>();

export const DEFAULT_SURFACE_KIND = 'web';

/** The surface kinds octomux ships. Plugins may not redefine these. */
export const CORE_SURFACE_KINDS = ['web', 'cli', 'slack', 'telegram'] as const;

let frozen = false;

export function registerSurface(s: SurfaceDefinition): void {
  // Check the freeze guard first: it's the more specific diagnostic, and in
  // the real boot sequence (core surfaces register, then freezeCoreSurfaces()
  // runs) a core kind is always ALSO a duplicate by the time a plugin can
  // reach this function — so if the duplicate check ran first it would win
  // every time and this branch would never fire.
  if (frozen && (CORE_SURFACE_KINDS as readonly string[]).includes(s.kind)) {
    logger.warn({ surface_kind: s.kind }, 'refusing to redefine core surface after freeze');
    return;
  }
  if (surfaces.has(s.kind)) {
    // ponytail: warn-only so a bad upgrade can't brick boot; make fatal in 2.0.
    logger.warn({ surface_kind: s.kind }, 'surface already registered, keeping first registration');
    return;
  }
  surfaces.set(s.kind, s);
}

/**
 * Locks the core surface kinds against redefinition. Call once at boot,
 * after all four core surfaces have registered and before any plugin loads.
 */
export function freezeCoreSurfaces(): void {
  frozen = true;
}

/** Test-only: clears the registry and unfreezes it. */
export function resetSurfaces(): void {
  surfaces.clear();
  frozen = false;
}

/** Removes one plugin-registered surface. Refuses (logs a warn, no-op) on
 *  any `CORE_SURFACE_KINDS` member — core surfaces are un-unregisterable. */
export function unregisterSurface(kind: string): boolean {
  if ((CORE_SURFACE_KINDS as readonly string[]).includes(kind)) {
    logger.warn({ surface_kind: kind }, 'refusing to unregister core surface');
    return false;
  }
  return surfaces.delete(kind);
}

export function getSurface(kind: string): SurfaceDefinition | undefined {
  return surfaces.get(kind);
}

export function listSurfaces(): SurfaceDefinition[] {
  return Array.from(surfaces.values());
}
