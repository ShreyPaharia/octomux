import { claudeCodeHarness } from './claude-code.js';
import { cursorHarness } from './cursor.js';
import type { Harness } from './types.js';

const HARNESSES = new Map<string, Harness>([
  [claudeCodeHarness.id, claudeCodeHarness],
  [cursorHarness.id, cursorHarness],
]);

export const DEFAULT_HARNESS_ID = claudeCodeHarness.id;

export function getHarness(id: string | null | undefined): Harness {
  const key = id ?? DEFAULT_HARNESS_ID;
  const h = HARNESSES.get(key);
  if (!h) throw new Error(`Unknown harness: ${key}`);
  return h;
}

export function listHarnesses(): Harness[] {
  return Array.from(HARNESSES.values());
}
