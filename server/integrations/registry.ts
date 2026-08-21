import { childLogger } from '../logger.js';
import type { IntegrationProvider } from './types.js';

const logger = childLogger('integrations/registry');

const providers = new Map<string, IntegrationProvider>();

/** Provider kinds `index.ts`'s side-effect imports register at boot — reserved
 *  namespace a plugin can never claim once `freezeCoreProviders()` has run. */
export const CORE_PROVIDER_KINDS = ['jira', 'linear', 'slack-gateway', 'telegram-gateway'] as const;

let coreFrozen = false;

/** Call once core's own providers have registered (after the side-effect imports
 *  in `index.ts`), before any plugin gets a chance to register. */
export function freezeCoreProviders(): void {
  coreFrozen = true;
}

/**
 * ponytail: warn-and-keep-first, not throw, until the release after the plugin
 * loader ships (T8). A boot that hard-fails where it previously last-write-wins
 * is an upgrade that reconciles nobody's running state — flip to throw once
 * plugin authors have had a release to see the warning and fix their manifest.
 */
export function registerProvider(p: IntegrationProvider): void {
  // Check the freeze guard first: it's the more specific diagnostic, and in
  // the real boot sequence (all four core providers register, then
  // freezeCoreProviders() runs) a core kind is always ALSO a duplicate by the
  // time a plugin can reach this function — so if the duplicate check ran
  // first it would win every time and this branch would never fire.
  if (coreFrozen && (CORE_PROVIDER_KINDS as readonly string[]).includes(p.kind)) {
    logger.warn({ kind: p.kind }, 'refusing plugin registration of a reserved core provider kind');
    return;
  }
  if (providers.has(p.kind)) {
    logger.warn({ kind: p.kind }, 'duplicate provider registration ignored, keeping first');
    return;
  }
  providers.set(p.kind, p);
}

/** Removes one plugin-registered provider. Refuses (logs a warn, no-op) on any
 *  `CORE_PROVIDER_KINDS` member — core provider kinds are un-unregisterable. */
export function unregisterProvider(kind: string): boolean {
  if ((CORE_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    logger.warn({ kind }, 'refusing to unregister core provider kind');
    return false;
  }
  return providers.delete(kind);
}

export function getProvider(kind: string): IntegrationProvider | undefined {
  return providers.get(kind);
}

export function listProviders(): IntegrationProvider[] {
  return Array.from(providers.values());
}

/** Test-only: clears all registered providers and unfreezes core. */
export function resetProviders(): void {
  providers.clear();
  coreFrozen = false;
}
