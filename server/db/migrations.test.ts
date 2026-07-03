import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA, applyPragmas } from './schema.js';
import { runMigrations } from './migrations.js';
import {
  TASKS_TABLE_COLUMNS,
  AGENTS_TABLE_COLUMNS,
  WORKTREES_TABLE_COLUMNS,
} from '../test-helpers.js';

describe('runMigrations (isolated)', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('applies migrations to a fresh in-memory DB and produces the expected schema', () => {
    db = new Database(':memory:');
    applyPragmas(db);
    db.exec(SCHEMA);
    runMigrations(db);

    const fk = db.pragma('foreign_keys') as [{ foreign_keys: number }];
    expect(fk[0].foreign_keys).toBe(1);

    const taskCols = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
    for (const col of TASKS_TABLE_COLUMNS) {
      expect(taskCols).toContain(col);
    }
    expect(taskCols).not.toContain('status');

    const agentCols = (db.pragma('table_info(agents)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const col of AGENTS_TABLE_COLUMNS) {
      expect(agentCols).toContain(col);
    }

    const wtCols = (db.pragma('table_info(worktrees)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(wtCols).toEqual(WORKTREES_TABLE_COLUMNS);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('review_runs');
    expect(tables).toContain('orchestrator_conversations');

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_tasks_active_worktree');
  });

  it('is idempotent when run twice on the same database', () => {
    db = new Database(':memory:');
    applyPragmas(db);
    db.exec(SCHEMA);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
