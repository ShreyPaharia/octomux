import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import {
  getKvEntry,
  putKvEntry,
  deleteKvEntry,
  listKvEntries,
  listKvEntriesOwnedByOthers,
  deletePluginKv,
} from './plugin-kv.js';

describe('plugin-kv repository', () => {
  beforeEach(() => {
    createTestDb();
  });

  it.each([
    ['object', { a: 1, b: 'two' }],
    ['array', [1, 2, 3]],
    ['number', 42],
    ['null', null],
    ['boolean', true],
  ])('round-trips a %s value through set → get', (_label, value) => {
    const stored = putKvEntry('coverage-bot', 'k', value);
    expect(stored.value).toEqual(value);
    expect(getKvEntry('coverage-bot', 'k')!.value).toEqual(value);
  });

  it('stores undefined as null', () => {
    const stored = putKvEntry('coverage-bot', 'k', undefined);
    expect(stored.value).toBeNull();
  });

  it('returns undefined for a missing key', () => {
    expect(getKvEntry('coverage-bot', 'nope')).toBeUndefined();
  });

  it('upsert replaces rather than appends, and bumps updated_at without changing created_at', async () => {
    const first = putKvEntry('coverage-bot', 'k', { n: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    const second = putKvEntry('coverage-bot', 'k', { n: 2 });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.value).toEqual({ n: 2 });
    expect(listKvEntries('coverage-bot')).toHaveLength(1);
  });

  it('a plain write (no owner arg) settles any in-flight owner mark', () => {
    putKvEntry('coverage-bot', 'k', { n: 1 }, 'mount-a');
    expect(getKvEntry('coverage-bot', 'k')!.owner).toBe('mount-a');

    putKvEntry('coverage-bot', 'k', { n: 2 });
    expect(getKvEntry('coverage-bot', 'k')!.owner).toBeNull();
  });

  it('delete returns true when a row was removed and false otherwise', () => {
    putKvEntry('coverage-bot', 'k', { n: 1 });
    expect(deleteKvEntry('coverage-bot', 'k')).toBe(true);
    expect(deleteKvEntry('coverage-bot', 'k')).toBe(false);
    expect(getKvEntry('coverage-bot', 'k')).toBeUndefined();
  });

  it('listKvEntries returns every entry for a plugin ordered by key ASC', () => {
    putKvEntry('coverage-bot', 'b', 2);
    putKvEntry('coverage-bot', 'a', 1);
    putKvEntry('coverage-bot', 'c', 3);

    expect(listKvEntries('coverage-bot').map((e) => e.key)).toEqual(['a', 'b', 'c']);
  });

  it('listKvEntries filters by key prefix', () => {
    putKvEntry('coverage-bot', 'run:1', 1);
    putKvEntry('coverage-bot', 'run:2', 2);
    putKvEntry('coverage-bot', 'other', 3);

    expect(listKvEntries('coverage-bot', 'run:').map((e) => e.key)).toEqual(['run:1', 'run:2']);
  });

  it('treats % and _ in a prefix as literal characters, not SQL LIKE wildcards', () => {
    putKvEntry('coverage-bot', '100%done', 1);
    putKvEntry('coverage-bot', '100Xdone', 2);
    putKvEntry('coverage-bot', 'a_b', 3);
    putKvEntry('coverage-bot', 'aXb', 4);

    expect(listKvEntries('coverage-bot', '100%').map((e) => e.key)).toEqual(['100%done']);
    expect(listKvEntries('coverage-bot', 'a_').map((e) => e.key)).toEqual(['a_b']);
  });

  it('scopes reads to the given plugin — plugin A never sees plugin B keys', () => {
    putKvEntry('coverage-bot', 'k', 1);
    putKvEntry('other-bot', 'k', 2);

    expect(listKvEntries('coverage-bot').map((e) => e.pluginId)).toEqual(['coverage-bot']);
    expect(listKvEntries('other-bot').map((e) => e.pluginId)).toEqual(['other-bot']);
    expect(getKvEntry('coverage-bot', 'k')!.value).toBe(1);
    expect(getKvEntry('other-bot', 'k')!.value).toBe(2);
  });

  it('listKvEntriesOwnedByOthers returns only rows owned by a different mount, excluding unowned and self-owned rows', () => {
    putKvEntry('coverage-bot', 'a', 1, 'mount-old');
    putKvEntry('coverage-bot', 'b', 2, 'mount-current');
    putKvEntry('coverage-bot', 'c', 3, null);
    putKvEntry('other-bot', 'd', 4, 'mount-old');

    const stale = listKvEntriesOwnedByOthers('coverage-bot', 'mount-current');
    expect(stale.map((e) => e.key)).toEqual(['a']);
  });

  it('deletePluginKv returns the count removed and leaves other plugins alone', () => {
    putKvEntry('coverage-bot', 'a', 1);
    putKvEntry('coverage-bot', 'b', 2);
    putKvEntry('other-bot', 'a', 3);

    expect(deletePluginKv('coverage-bot')).toBe(2);
    expect(listKvEntries('coverage-bot')).toHaveLength(0);
    expect(listKvEntries('other-bot')).toHaveLength(1);
  });
});
