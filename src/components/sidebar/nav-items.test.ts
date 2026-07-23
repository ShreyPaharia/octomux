import { describe, it, expect } from 'vitest';
import { MORE_ITEMS, NAV_ITEMS, deriveActiveNav } from './nav-items';

describe('MORE_ITEMS', () => {
  it('is the static list — no per-workflow-kind rows', () => {
    const keys = MORE_ITEMS.map((item) => item.key);
    expect(keys).toEqual(['monitor', 'workspaces', 'orchestrator', 'agents', 'schedules']);
  });

  it('does not list a workflow kind twice', () => {
    const keys = MORE_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('NAV_ITEMS', () => {
  it('includes Runs between Tasks and Reviews', () => {
    const keys = NAV_ITEMS.map((item) => item.key);
    expect(keys).toEqual(['home', 'tasks', 'runs', 'reviews', 'settings']);
  });
});

describe('deriveActiveNav', () => {
  it('marks /runs active', () => {
    expect(deriveActiveNav('/runs', null)).toBe('runs');
  });
});
