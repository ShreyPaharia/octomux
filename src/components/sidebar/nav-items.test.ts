import { describe, it, expect, beforeAll } from 'vitest';

describe('MORE_ITEMS', () => {
  beforeAll(async () => {
    await import('@/workflows/index');
  });

  it('includes both registered workflow kinds alongside the static entries', async () => {
    const { MORE_ITEMS } = await import('./nav-items');
    const keys = MORE_ITEMS.map((item) => item.key);
    expect(keys).toEqual(
      expect.arrayContaining(['monitor', 'workspaces', 'orchestrator', 'loops', 'pr-extract']),
    );
  });

  it('does not list a workflow kind twice', async () => {
    const { MORE_ITEMS } = await import('./nav-items');
    const keys = MORE_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
