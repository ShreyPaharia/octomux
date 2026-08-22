import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import {
  appendRecord,
  upsertRecord,
  getRecord,
  queryRecords,
  readRecordsForTask,
  deleteRecordsForTask,
  markInFlight,
  clearInFlight,
  listInFlightOwnedByOthers,
} from './plugin-records.js';

beforeEach(() => {
  createTestDb();
});

describe('plugin-records repository', () => {
  it('appends two rows to one store without colliding (key IS NULL excluded from the unique index)', () => {
    appendRecord('p:log', 't1', { n: 1 });
    appendRecord('p:log', 't1', { n: 2 });
    expect(readRecordsForTask('t1', 'p:log')).toHaveLength(2);
  });

  it('upsert keeps seq and created_at stable — ON CONFLICT, never INSERT OR REPLACE', () => {
    const first = upsertRecord('p:leads', null, 'a', { v: 1 });
    const second = upsertRecord('p:leads', null, 'a', { v: 2 });
    expect(second.seq).toBe(first.seq);
    expect(second.createdAt).toBe(first.createdAt);
    expect(getRecord('p:leads', 'a')?.payload).toEqual({ v: 2 });
  });

  it('an ordinary upsert clears owner, settling an in-flight checkpoint', () => {
    markInFlight('p:kv', 'job', { step: 1 }, 'mount-A');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(1);
    upsertRecord('p:kv', null, 'job', { step: 2 });
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(0);
  });

  it('interrupted work is what some OTHER mount left behind', () => {
    markInFlight('p:kv', 'job', { step: 1 }, 'mount-A');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-A')).toHaveLength(0);
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(1);
    clearInFlight('p:kv', 'job');
    expect(listInFlightOwnedByOthers(['p:kv'], 'mount-B')).toHaveLength(0);
  });

  it('deleteRecordsForTask removes task-scoped rows and leaves durable ones', () => {
    appendRecord('p:log', 't1', { n: 1 });
    upsertRecord('p:leads', null, 'a', { v: 1 });
    deleteRecordsForTask('t1');
    expect(readRecordsForTask('t1')).toHaveLength(0);
    expect(getRecord('p:leads', 'a')).toBeDefined();
  });

  it('queryRecords filters, orders and windows — the ported QuerySpec contract', () => {
    upsertRecord('p:leads', null, 'a', { stage: 'new', score: 3 });
    upsertRecord('p:leads', null, 'b', { stage: 'won', score: 1 });
    upsertRecord('p:leads', null, 'c', { stage: 'new', score: 2 });

    // where: exact match on a top-level field
    const isNew = queryRecords('p:leads', { where: { stage: 'new' } });
    expect(isNew.map((r) => r.key).sort()).toEqual(['a', 'c']);

    // orderBy + order
    const desc = queryRecords('p:leads', { orderBy: 'score', order: 'desc' });
    expect(desc.map((r) => r.key)).toEqual(['a', 'c', 'b']);

    // limit + offset — the windowing panelsForStore depends on
    const page = queryRecords('p:leads', {
      orderBy: 'score',
      order: 'desc',
      limit: 1,
      offset: 1,
    });
    expect(page.map((r) => r.key)).toEqual(['c']);

    // a store with no rows returns empty, not undefined
    expect(queryRecords('p:empty')).toEqual([]);
  });
});
