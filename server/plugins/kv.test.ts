import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import { kvGet, kvSet, kvDel, kvList, kvBegin, kvEnd, kvInterrupted } from './kv.js';

describe('ctx.kv free functions', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('round-trips a value through set → get, preserving type', () => {
    kvSet('demo', 'k', { count: 3, tags: ['a', 'b'] });
    expect(kvGet('demo', 'k')).toEqual({ count: 3, tags: ['a', 'b'] });
  });

  it('get on a missing key is undefined', () => {
    expect(kvGet('demo', 'nope')).toBeUndefined();
  });

  it('del removes the key', () => {
    kvSet('demo', 'k', 1);
    kvDel('demo', 'k');
    expect(kvGet('demo', 'k')).toBeUndefined();
  });

  it('del on a missing key is a no-op, not a throw', () => {
    expect(() => kvDel('demo', 'nope')).not.toThrow();
  });

  it('list with no prefix returns every key for the plugin, ordered by key ASC', () => {
    kvSet('demo', 'b', 2);
    kvSet('demo', 'a', 1);
    kvSet('demo', 'c', 3);
    expect(kvList('demo')).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'c', value: 3 },
    ]);
  });

  it('list with a prefix narrows to matching keys, still key ASC', () => {
    kvSet('demo', 'job:2', 'y');
    kvSet('demo', 'job:1', 'x');
    kvSet('demo', 'other:1', 'z');
    expect(kvList('demo', 'job:')).toEqual([
      { key: 'job:1', value: 'x' },
      { key: 'job:2', value: 'y' },
    ]);
  });

  it.each([
    ['get', () => kvGet('demo', '')],
    ['set', () => kvSet('demo', '', 1)],
    ['del', () => kvDel('demo', '')],
    ['begin', () => kvBegin('demo', 'mount-1', '', 1)],
    ['end', () => kvEnd('demo', '')],
  ])('%s rejects an empty key, naming the plugin', (_label, call) => {
    expect(call).toThrow(/"demo"/);
  });

  describe('plugin scoping', () => {
    it('plugin A cannot read plugin B keys via kvGet', () => {
      kvSet('plugin-a', 'k', 'a-value');
      kvSet('plugin-b', 'k', 'b-value');
      expect(kvGet('plugin-a', 'k')).toBe('a-value');
      expect(kvGet('plugin-b', 'k')).toBe('b-value');
    });

    it('plugin A cannot see plugin B keys via kvList', () => {
      kvSet('plugin-a', 'k1', 1);
      kvSet('plugin-b', 'k2', 2);
      expect(kvList('plugin-a')).toEqual([{ key: 'k1', value: 1 }]);
      expect(kvList('plugin-b')).toEqual([{ key: 'k2', value: 2 }]);
    });
  });

  describe('crash recovery: begin / end / interrupted', () => {
    it('a NEW mount sees a checkpoint left by another mount, with its value and a startedAt', () => {
      kvBegin('demo', 'mount-1', 'job:1', { step: 'fetch' });

      const seen = kvInterrupted('demo', 'mount-2');
      expect(seen).toHaveLength(1);
      expect(seen[0].key).toBe('job:1');
      expect(seen[0].value).toEqual({ step: 'fetch' });
      expect(typeof seen[0].startedAt).toBe('string');
    });

    it('the SAME mount does not see its own in-flight checkpoint as interrupted', () => {
      kvBegin('demo', 'mount-1', 'job:1', { step: 'fetch' });
      expect(kvInterrupted('demo', 'mount-1')).toEqual([]);
    });

    it('kvEnd clears the checkpoint so no mount sees it as interrupted', () => {
      kvBegin('demo', 'mount-1', 'job:1', { step: 'fetch' });
      kvEnd('demo', 'job:1');

      expect(kvInterrupted('demo', 'mount-2')).toEqual([]);
      expect(kvGet('demo', 'job:1')).toBeUndefined();
    });

    it('a plain kvSet on an in-flight key settles the mark — it stops showing as interrupted', () => {
      kvBegin('demo', 'mount-1', 'job:1', { step: 'fetch' });
      kvSet('demo', 'job:1', { step: 'done' });

      expect(kvInterrupted('demo', 'mount-2')).toEqual([]);
      // The settled value is still readable via the ordinary get path.
      expect(kvGet('demo', 'job:1')).toEqual({ step: 'done' });
    });

    it("interrupted() is scoped per plugin — one plugin never sees another plugin's in-flight marks", () => {
      kvBegin('plugin-a', 'mount-1', 'job:1', 'a-checkpoint');
      kvBegin('plugin-b', 'mount-1', 'job:1', 'b-checkpoint');

      const seenForA = kvInterrupted('plugin-a', 'mount-2');
      expect(seenForA).toHaveLength(1);
      expect(seenForA[0].value).toBe('a-checkpoint');
    });
  });
});
