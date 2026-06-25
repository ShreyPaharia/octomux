import type { Harness } from './types.js';

const harnesses = new Map<string, Harness>();

export const DEFAULT_HARNESS_ID = 'claude-code';

export function registerHarness(h: Harness): void {
  harnesses.set(h.id, h);
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
