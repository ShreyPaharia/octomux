import type { IntegrationProvider } from './types.js';

const providers = new Map<string, IntegrationProvider>();

export function registerProvider(p: IntegrationProvider): void {
  providers.set(p.kind, p);
}

export function getProvider(kind: string): IntegrationProvider | undefined {
  return providers.get(kind);
}

export function listProviders(): IntegrationProvider[] {
  return Array.from(providers.values());
}
