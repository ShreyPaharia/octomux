import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses, DEFAULT_HARNESS_ID } from './index.js';

describe('registry', () => {
  it('returns claude-code by id', () => {
    const h = getHarness('claude-code');
    expect(h.id).toBe('claude-code');
  });

  it('returns the default when id is null/undefined', () => {
    expect(getHarness(null).id).toBe(DEFAULT_HARNESS_ID);
    expect(getHarness(undefined).id).toBe(DEFAULT_HARNESS_ID);
  });

  it('throws on unknown id', () => {
    expect(() => getHarness('nonexistent')).toThrow(/Unknown harness/);
  });

  it('returns cursor by id', () => {
    const h = getHarness('cursor');
    expect(h.id).toBe('cursor');
    expect(h.sessionIdMode).toBe('harness-issued');
  });

  it('lists registered harnesses', () => {
    const ids = listHarnesses().map((h) => h.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('cursor');
  });
});
