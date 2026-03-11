import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  getTask,
  getAgents,
  getPermissionPrompts,
  DEFAULTS,
  TASKS_TABLE_COLUMNS,
  AGENTS_TABLE_COLUMNS,
  PERMISSION_PROMPTS_TABLE_COLUMNS,
} from './test-helpers.js';
import { getDb, initDb } from './db.js';

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
      { table: 'task', field: 'status', expected: 'draft' },
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

  // ─── Pragmas ──────────────────────────────────────────────────────────

  describe('pragmas', () => {
    it('sets WAL journal mode (falls back to memory for in-memory DBs)', () => {
      const mode = db.pragma('journal_mode') as [{ journal_mode: string }];
      // In-memory DBs can't use WAL; real DBs will use WAL
      expect(['wal', 'memory']).toContain(mode[0].journal_mode);
    });

    it('enables foreign keys', () => {
      const fk = db.pragma('foreign_keys') as [{ foreign_keys: number }];
      expect(fk[0].foreign_keys).toBe(1);
    });
  });

  // ─── Migrations ────────────────────────────────────────────────────────

  describe('migrations', () => {
    it('is idempotent — calling initDb twice does not error', () => {
      expect(() => initDb(db)).not.toThrow();
    });

    it.each(['initial_prompt', 'base_branch'])('tasks table has column: %s (migration)', (col) => {
      const columns = db.pragma('table_info(tasks)') as { name: string }[];
      expect(columns.map((c) => c.name)).toContain(col);
    });

    it('agents table has claude_session_id column (migration)', () => {
      const columns = db.pragma('table_info(agents)') as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('claude_session_id');
    });
  });

  // ─── Permission Prompts ──────────────────────────────────────────────

  describe('permission_prompts table', () => {
    it('creates permission_prompts table with correct columns', () => {
      const cols = (db.pragma('table_info(permission_prompts)') as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toEqual(PERMISSION_PROMPTS_TABLE_COLUMNS);
    });

    it('adds hook_activity column to agents table', () => {
      const cols = (db.pragma('table_info(agents)') as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('hook_activity');
      expect(cols).toContain('hook_activity_updated_at');
    });

    it('resolves stale pending prompts on startup', () => {
      insertTask(db, { id: 't1', status: 'running' });
      insertAgent(db, { id: 'a1', task_id: 't1' });
      insertPermissionPrompt(db, { id: 'pp1', task_id: 't1', agent_id: 'a1', status: 'pending' });

      // Re-init simulates restart
      initDb(db);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts[0].status).toBe('resolved');
      expect(prompts[0].resolved_at).not.toBeNull();
    });

    it('resets waiting agents to active on startup', () => {
      insertTask(db, { id: 't1', status: 'running' });
      insertAgent(db, { id: 'a1', task_id: 't1', hook_activity: 'waiting' });

      // Re-init simulates restart
      initDb(db);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('active');
    });

    it('does not reset idle or stopped agents on startup', () => {
      insertTask(db, { id: 't1', status: 'running' });
      insertAgent(db, { id: 'a1', task_id: 't1', hook_activity: 'idle', status: 'stopped' });

      initDb(db);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('idle');
    });
  });
});
