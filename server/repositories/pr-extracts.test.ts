import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, insertTask } from '../test-helpers.js';
import { createExtract, getExtract, getExtractByTaskId, listExtracts } from './pr-extracts.js';

describe('pr-extracts repository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  function seedTask(id: string) {
    insertTask(db, { id, source: 'pr_extract' });
  }

  it('creates and reads back an extract row', () => {
    seedTask('task-1');
    const row = createExtract({
      taskId: 'task-1',
      repoPath: '/repo',
      prNumber: 42,
      prHeadSha: 'sha-abc',
      area: 'server',
      risk: 'medium',
      hasMigration: true,
      surface: 'api',
      loc: 120,
    });

    expect(row.id).toBeTruthy();
    expect(row.has_migration).toBe(true);
    expect(getExtract(row.id)).toEqual(row);
    expect(getExtractByTaskId('task-1')).toEqual(row);
  });

  it('round-trips has_migration=false as boolean false, not 0', () => {
    seedTask('task-2');
    const row = createExtract({
      taskId: 'task-2',
      repoPath: '/repo',
      prNumber: 43,
      prHeadSha: 'sha-def',
      area: 'server',
      risk: 'low',
      hasMigration: false,
      surface: 'cli',
      loc: 10,
    });
    expect(row.has_migration).toBe(false);
    expect(getExtract(row.id)!.has_migration).toBe(false);
  });

  it('rejects a second extract for the same task', () => {
    seedTask('task-3');
    const base = {
      taskId: 'task-3',
      repoPath: '/repo',
      prNumber: 44,
      prHeadSha: 'sha-ghi',
      area: 'server',
      risk: 'low' as const,
      hasMigration: false,
      surface: 'cli',
      loc: 1,
    };
    createExtract(base);
    expect(() => createExtract(base)).toThrow();
  });

  it('lists extracts newest first', () => {
    seedTask('task-4');
    seedTask('task-5');
    const a = createExtract({
      taskId: 'task-4',
      repoPath: '/repo',
      prNumber: 1,
      prHeadSha: 's1',
      area: 'a',
      risk: 'low',
      hasMigration: false,
      surface: 's',
      loc: 1,
    });
    const b = createExtract({
      taskId: 'task-5',
      repoPath: '/repo',
      prNumber: 2,
      prHeadSha: 's2',
      area: 'a',
      risk: 'low',
      hasMigration: false,
      surface: 's',
      loc: 1,
    });
    const rows = listExtracts();
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});
