import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  getTask,
  getAgents,
  DEFAULTS,
  TASKS_TABLE_COLUMNS,
  AGENTS_TABLE_COLUMNS,
} from './test-helpers.js';
import { getDb } from './db.js';

describe('Database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  // ─── Schema Tests (table-driven) ────────────────────────────────────────

  describe('schema', () => {
    it.each(TASKS_TABLE_COLUMNS)('tasks table has column: %s', (col) => {
      const columns = db.pragma('table_info(tasks)') as { name: string }[];
      expect(columns.map((c) => c.name)).toContain(col);
    });

    it.each(AGENTS_TABLE_COLUMNS)('agents table has column: %s', (col) => {
      const columns = db.pragma('table_info(agents)') as { name: string }[];
      expect(columns.map((c) => c.name)).toContain(col);
    });

    it('creates idx_tasks_status index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain('idx_tasks_status');
    });

    it('creates idx_agents_task index', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agents'")
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain('idx_agents_task');
    });
  });

  // ─── Constraint Tests ───────────────────────────────────────────────────

  describe('constraints', () => {
    it('enforces foreign key on agents.task_id', () => {
      expect(() => insertAgent(db, { task_id: 'nonexistent' })).toThrow();
    });

    it('enforces unique task id', () => {
      insertTask(db);
      expect(() => insertTask(db)).toThrow();
    });

    it('enforces NOT NULL on required task fields', () => {
      expect(() => {
        db.prepare(
          'INSERT INTO tasks (id, title, description, repo_path) VALUES (?, NULL, ?, ?)',
        ).run('t1', 'desc', '/tmp');
      }).toThrow();
    });
  });

  // ─── Default Values ─────────────────────────────────────────────────────

  describe('defaults', () => {
    const defaultCases = [
      { table: 'task', field: 'status', expected: 'created' },
      { table: 'agent', field: 'status', expected: 'running' },
    ] as const;

    it.each(defaultCases)('$table.$field defaults to $expected', ({ table, field, expected }) => {
      insertTask(db);
      if (table === 'agent') insertAgent(db);

      const row =
        table === 'task' ? getTask(db, DEFAULTS.task.id) : getAgents(db, DEFAULTS.task.id)[0];
      expect((row as any)[field]).toBe(expected);
    });

    it('auto-populates created_at and updated_at on tasks', () => {
      db.prepare('INSERT INTO tasks (id, title, description, repo_path) VALUES (?, ?, ?, ?)').run(
        'auto-ts',
        'T',
        'D',
        '/tmp',
      );
      const task = getTask(db, 'auto-ts')!;
      expect(task.created_at).toBeTruthy();
      expect(task.updated_at).toBeTruthy();
    });

    it('auto-populates created_at on agents', () => {
      insertTask(db);
      db.prepare('INSERT INTO agents (id, task_id, window_index, label) VALUES (?, ?, ?, ?)').run(
        'auto-agent',
        DEFAULTS.task.id,
        0,
        'A1',
      );
      const agents = getAgents(db, DEFAULTS.task.id);
      expect(agents[0].created_at).toBeTruthy();
    });
  });

  // ─── Cascade Delete ─────────────────────────────────────────────────────

  describe('cascade delete', () => {
    it('deletes agents when task is deleted', () => {
      insertTask(db);
      insertAgent(db);
      insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

      db.prepare('DELETE FROM tasks WHERE id = ?').run(DEFAULTS.task.id);

      expect(getAgents(db, DEFAULTS.task.id)).toHaveLength(0);
    });
  });

  // ─── Singleton ──────────────────────────────────────────────────────────

  describe('getDb', () => {
    it('returns the same instance on repeated calls', () => {
      expect(getDb()).toBe(getDb());
    });
  });
});
