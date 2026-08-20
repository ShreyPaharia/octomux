import { describe, it, expect, beforeEach } from '../bun-test.js';
import type Database from '../sqlite.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import { insertFact, getFact, readFactsForTask, deleteFactsForTask } from './plugin-facts.js';

describe('plugin-facts repository', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db, { id: 'task-1' });
    insertTask(db, { id: 'task-2' });
  });

  it('inserts and reads back a fact, with seq assigned and payload round-tripped', () => {
    const fact = insertFact('task-1', 'coverage-bot:coverage', { pct: 87 });
    expect(fact.seq).toBeGreaterThan(0);
    expect(fact.taskId).toBe('task-1');
    expect(fact.type).toBe('coverage-bot:coverage');
    expect(fact.payload).toEqual({ pct: 87 });
    expect(getFact(fact.seq)).toEqual(fact);
  });

  it('defaults payload to {} when omitted', () => {
    const fact = insertFact('task-1', 'core:diff', undefined);
    expect(fact.payload).toEqual({});
  });

  it('reads facts for a task in seq order, scoped to that task only', () => {
    const a = insertFact('task-1', 'core:diff', { n: 1 });
    const b = insertFact('task-1', 'core:tests.passed', { n: 2 });
    insertFact('task-2', 'core:diff', { n: 99 });

    const rows = readFactsForTask('task-1');
    expect(rows.map((r) => r.seq)).toEqual([a.seq, b.seq]);
  });

  it('filters by qualified type', () => {
    insertFact('task-1', 'core:diff', { n: 1 });
    const b = insertFact('task-1', 'core:tests.passed', { n: 2 });

    const rows = readFactsForTask('task-1', { type: 'core:tests.passed' });
    expect(rows.map((r) => r.seq)).toEqual([b.seq]);
  });

  it('filters by sinceSeq', () => {
    const a = insertFact('task-1', 'core:diff', { n: 1 });
    const b = insertFact('task-1', 'core:diff', { n: 2 });

    const rows = readFactsForTask('task-1', { sinceSeq: a.seq });
    expect(rows.map((r) => r.seq)).toEqual([b.seq]);
  });

  it('deletes all facts for a task and leaves other tasks untouched', () => {
    const a = insertFact('task-1', 'core:diff', { n: 1 });
    const other = insertFact('task-2', 'core:diff', { n: 2 });

    deleteFactsForTask('task-1');

    expect(getFact(a.seq)).toBeUndefined();
    expect(getFact(other.seq)).toEqual(other);
  });
});
