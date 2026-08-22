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
});
