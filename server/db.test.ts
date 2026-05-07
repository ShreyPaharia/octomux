import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  insertUserTerminal,
  getUserTerminals,
  getTask,
  getAgents,
  getPermissionPrompts,
  DEFAULTS,
  TASKS_TABLE_COLUMNS,
  AGENTS_TABLE_COLUMNS,
  PERMISSION_PROMPTS_TABLE_COLUMNS,
  USER_TERMINALS_TABLE_COLUMNS,
  WORKTREES_TABLE_COLUMNS,
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

    const indexCases = [
      { table: 'tasks', index: 'idx_tasks_status' },
      { table: 'agents', index: 'idx_agents_task' },
    ];

    it.each(indexCases)('creates $index on $table', ({ table, index }) => {
      const indexes = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`)
        .all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toContain(index);
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
      db.prepare('INSERT INTO tasks (id, title, description) VALUES (?, ?, ?)').run(
        'auto-ts',
        'T',
        'D',
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

    const migrationColumns = [
      { table: 'tasks', column: 'initial_prompt' },
      { table: 'tasks', column: 'worktree_id' },
      { table: 'agents', column: 'claude_session_id' },
    ];

    it.each(migrationColumns)('$table has $column column (migration)', ({ table, column }) => {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      expect(columns.map((c) => c.name)).toContain(column);
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

    const startupActivityCases = [
      {
        initial: 'waiting' as const,
        status: 'running' as const,
        expected: 'active',
        desc: 'resets waiting to active',
      },
      {
        initial: 'idle' as const,
        status: 'stopped' as const,
        expected: 'idle',
        desc: 'does not reset idle/stopped',
      },
    ];

    it.each(startupActivityCases)('$desc on startup', ({ initial, status, expected }) => {
      insertTask(db, { id: 't1', status: 'running' });
      insertAgent(db, { id: 'a1', task_id: 't1', hook_activity: initial, status });

      initDb(db);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe(expected);
    });
  });

  // ─── Phase 2a: worktrees + standalone agents ────────────────────────────

  describe('phase 2a migration', () => {
    it('creates worktrees table with expected columns', () => {
      const cols = (db.pragma('table_info(worktrees)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toEqual(WORKTREES_TABLE_COLUMNS);
    });

    it('adds tasks.worktree_id column', () => {
      const cols = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('worktree_id');
    });

    it('makes agents.task_id nullable', () => {
      const rows = db.pragma('table_info(agents)') as Array<{
        name: string;
        notnull: number;
      }>;
      const col = rows.find((c) => c.name === 'task_id')!;
      expect(col.notnull).toBe(0);
    });

    it('adds agents.tmux_session and agents.agent columns; drops legacy pinned', () => {
      const cols = (db.pragma('table_info(agents)') as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('tmux_session');
      expect(cols).toContain('agent');
      expect(cols).not.toContain('pinned');
    });

    it('adds tasks.agent column', () => {
      const cols = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('agent');
    });

    it('removes legacy seeded orchestrator agent row', () => {
      const row = db
        .prepare(`SELECT id FROM agents WHERE id = 'orchestrator' AND task_id IS NULL`)
        .get();
      expect(row).toBeUndefined();
    });

    it('allows inserting a standalone agent with NULL task_id', () => {
      const stmt = db.prepare(
        `INSERT INTO agents (id, task_id, window_index, label, tmux_session)
         VALUES (?, NULL, 0, 'chat', 'octomux-agent-chat-1')`,
      );
      expect(() => stmt.run('chat-1')).not.toThrow();
    });

    it('backfills worktrees from pre-existing task rows (legacy-schema sim)', () => {
      // Legacy schema no longer exists on fresh DBs; simulate it manually
      // with a second in-memory DB that predates the Phase 2a drop.
      const legacy = new (db.constructor as unknown as {
        new (path: string): typeof db;
      })(':memory:');
      legacy.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL,
          description TEXT NOT NULL, repo_path TEXT, status TEXT,
          branch TEXT, base_branch TEXT, worktree TEXT, tmux_session TEXT,
          pr_url TEXT, pr_number INTEGER, pr_head_sha TEXT,
          user_window_index INTEGER, initial_prompt TEXT, last_viewed_at TEXT,
          source TEXT, run_mode TEXT, base_sha TEXT, error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agents (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
          window_index INTEGER NOT NULL, label TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          claude_session_id TEXT,
          hook_activity TEXT NOT NULL DEFAULT 'active',
          hook_activity_updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE permission_prompts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
          agent_id TEXT, session_id TEXT, tool_name TEXT, tool_input TEXT,
          status TEXT, created_at TEXT, resolved_at TEXT);
        CREATE TABLE user_terminals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
          window_index INTEGER, label TEXT, status TEXT, created_at TEXT);
        CREATE TABLE repo_configs (repo_path TEXT PRIMARY KEY);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1));
        INSERT INTO tasks (id, title, description, repo_path, status,
          branch, base_branch, worktree, run_mode, base_sha)
        VALUES ('backfill-1','T','D','/tmp/repo','draft',
          'agents/foo','main','/tmp/repo/.worktrees/foo','new','abc123');
      `);
      initDb(legacy);

      const task = legacy
        .prepare('SELECT worktree_id FROM tasks WHERE id = ?')
        .get('backfill-1') as { worktree_id: string | null };
      expect(task.worktree_id).toBeTruthy();

      const wt = legacy.prepare('SELECT * FROM worktrees WHERE id = ?').get(task.worktree_id) as
        | { path: string; mode: string; branch: string; base_sha: string }
        | undefined;
      expect(wt).toBeTruthy();
      expect(wt!.path).toBe('/tmp/repo/.worktrees/foo');
      expect(wt!.mode).toBe('new');
      expect(wt!.branch).toBe('agents/foo');
      expect(wt!.base_sha).toBe('abc123');

      // Legacy columns must be gone after migration.
      const cols = (legacy.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      for (const c of ['worktree', 'run_mode', 'repo_path', 'branch', 'base_branch', 'base_sha']) {
        expect(cols).not.toContain(c);
      }
      legacy.close();
    });

    it('enforces one-active-task-per-worktree via partial unique index', () => {
      db.prepare(
        `INSERT INTO worktrees (id, path, mode, status) VALUES ('wt-1', '/tmp/wt', 'existing', 'in_use')`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, title, description, status, runtime_state, worktree_id)
         VALUES ('t-1','T','D','running','running','wt-1')`,
      ).run();
      expect(() => {
        db.prepare(
          `INSERT INTO tasks (id, title, description, status, runtime_state, worktree_id)
           VALUES ('t-2','T','D','running','running','wt-1')`,
        ).run();
      }).toThrow();
    });
  });

  // ─── User Terminals ──────────────────────────────────────────────────────

  describe('user_terminals table', () => {
    it('creates user_terminals table with expected columns', () => {
      const cols = db.pragma('table_info(user_terminals)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toEqual(USER_TERMINALS_TABLE_COLUMNS);
    });

    it('cascades user_terminals on task delete', () => {
      insertTask(db, DEFAULTS.runningTask);
      insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
      db.prepare('DELETE FROM tasks WHERE id = ?').run(DEFAULTS.runningTask.id);
      expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
    });
  });
});
