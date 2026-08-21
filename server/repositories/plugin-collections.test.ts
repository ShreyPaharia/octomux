import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import { upsertRecord, getRecord, queryRecords, deleteCollection } from './plugin-collections.js';

describe('plugin-collections repository', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('upserts and reads back a record, round-tripping the JSON payload', () => {
    const stored = upsertRecord('coverage-bot:baselines', 'main', { branch: 'main', pct: 87 });
    expect(stored.collection).toBe('coverage-bot:baselines');
    expect(stored.key).toBe('main');
    expect(stored.record).toEqual({ branch: 'main', pct: 87 });
    expect(getRecord('coverage-bot:baselines', 'main')).toEqual(stored);
  });

  it('returns undefined for a missing key', () => {
    expect(getRecord('coverage-bot:baselines', 'nope')).toBeUndefined();
  });

  it('replaces on the same key rather than appending, advancing updated_at but not created_at', async () => {
    const first = upsertRecord('coverage-bot:baselines', 'main', { pct: 87 });
    // Ensure a >=1s clock tick so datetime('now') (second resolution) can differ.
    await new Promise((r) => setTimeout(r, 1100));
    const second = upsertRecord('coverage-bot:baselines', 'main', { pct: 91 });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.record).toEqual({ pct: 91 });

    const all = queryRecords('coverage-bot:baselines');
    expect(all).toHaveLength(1);
  });

  it('scopes queries to the given collection only', () => {
    upsertRecord('coverage-bot:baselines', 'a', { n: 1 });
    upsertRecord('other-bot:baselines', 'a', { n: 2 });

    const rows = queryRecords('coverage-bot:baselines');
    expect(rows).toHaveLength(1);
    expect(rows[0].record).toEqual({ n: 1 });
  });

  it('filters with where on a top-level record field', () => {
    upsertRecord('coverage-bot:baselines', 'a', { branch: 'main', pct: 87 });
    upsertRecord('coverage-bot:baselines', 'b', { branch: 'dev', pct: 40 });

    const rows = queryRecords('coverage-bot:baselines', { where: { branch: 'main' } });
    expect(rows.map((r) => r.key)).toEqual(['a']);
  });

  it('filters with where on a number and a boolean value', () => {
    upsertRecord('coverage-bot:baselines', 'a', { pct: 87, passing: true });
    upsertRecord('coverage-bot:baselines', 'b', { pct: 40, passing: false });

    expect(
      queryRecords('coverage-bot:baselines', { where: { pct: 87 } }).map((r) => r.key),
    ).toEqual(['a']);
    expect(
      queryRecords('coverage-bot:baselines', { where: { passing: false } }).map((r) => r.key),
    ).toEqual(['b']);
  });

  it('orders by a top-level record field, ascending by default and descending on request', () => {
    upsertRecord('coverage-bot:baselines', 'a', { pct: 40 });
    upsertRecord('coverage-bot:baselines', 'b', { pct: 87 });
    upsertRecord('coverage-bot:baselines', 'c', { pct: 10 });

    expect(queryRecords('coverage-bot:baselines', { orderBy: 'pct' }).map((r) => r.key)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(
      queryRecords('coverage-bot:baselines', { orderBy: 'pct', order: 'desc' }).map((r) => r.key),
    ).toEqual(['b', 'a', 'c']);
  });

  it('defaults ordering to updated_at when orderBy is absent', () => {
    upsertRecord('coverage-bot:baselines', 'a', { pct: 40 });
    upsertRecord('coverage-bot:baselines', 'b', { pct: 87 });

    expect(queryRecords('coverage-bot:baselines').map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('applies limit and offset', () => {
    upsertRecord('coverage-bot:baselines', 'a', { pct: 1 });
    upsertRecord('coverage-bot:baselines', 'b', { pct: 2 });
    upsertRecord('coverage-bot:baselines', 'c', { pct: 3 });

    expect(
      queryRecords('coverage-bot:baselines', { orderBy: 'pct', limit: 2 }).map((r) => r.key),
    ).toEqual(['a', 'b']);
    expect(
      queryRecords('coverage-bot:baselines', { orderBy: 'pct', limit: 1, offset: 1 }).map(
        (r) => r.key,
      ),
    ).toEqual(['b']);
    expect(
      queryRecords('coverage-bot:baselines', { orderBy: 'pct', offset: 2 }).map((r) => r.key),
    ).toEqual(['c']);
  });

  it.each([["a'; DROP TABLE plugin_collections; --"], ['$.x'], ['has space'], ['has-dash']])(
    'rejects a hostile where field name %s rather than interpolating it into SQL',
    (field) => {
      upsertRecord('coverage-bot:baselines', 'a', { pct: 1 });
      expect(() => queryRecords('coverage-bot:baselines', { where: { [field]: 1 } })).toThrow(
        /invalid field name/,
      );
    },
  );

  it.each([["a'; DROP TABLE plugin_collections; --"], ['$.x']])(
    'rejects a hostile orderBy field name %s rather than interpolating it into SQL',
    (field) => {
      upsertRecord('coverage-bot:baselines', 'a', { pct: 1 });
      expect(() => queryRecords('coverage-bot:baselines', { orderBy: field })).toThrow(
        /invalid field name/,
      );
    },
  );

  it('deleteCollection removes every record in the collection and reports the count', () => {
    upsertRecord('coverage-bot:baselines', 'a', { pct: 1 });
    upsertRecord('coverage-bot:baselines', 'b', { pct: 2 });
    upsertRecord('other-bot:baselines', 'a', { pct: 3 });

    const deleted = deleteCollection('coverage-bot:baselines');
    expect(deleted).toBe(2);
    expect(queryRecords('coverage-bot:baselines')).toHaveLength(0);
    expect(queryRecords('other-bot:baselines')).toHaveLength(1);
  });
});
