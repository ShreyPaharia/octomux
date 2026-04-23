import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { childLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('db');
const isProduction = process.env.NODE_ENV === 'production';

const PROD_DB_DIR = path.join(os.homedir(), '.octomux', 'data');
const DEV_DB_DIR = path.join(__dirname, '..', 'data');
const DB_DIR = isProduction ? PROD_DB_DIR : DEV_DB_DIR;
const DB_PATH = path.join(DB_DIR, 'tasks.db');

/** Path to the old package-relative database (for migration detection). */
const OLD_DB_PATH = path.join(__dirname, '..', 'data', 'tasks.db');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL,
    repo_path    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft',
    branch       TEXT,
    base_branch  TEXT,
    worktree     TEXT,
    tmux_session TEXT,
    pr_url       TEXT,
    pr_number    INTEGER,
    initial_prompt TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    window_index      INTEGER NOT NULL,
    label             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running',
    claude_session_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permission_prompts (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    agent_id   TEXT,
    session_id TEXT NOT NULL,
    tool_name  TEXT NOT NULL,
    tool_input TEXT NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_agents_task ON agents(task_id);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_task_id ON permission_prompts(task_id);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_status ON permission_prompts(status);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status ON permission_prompts(agent_id, status);

CREATE TABLE IF NOT EXISTS user_terminals (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    window_index INTEGER NOT NULL,
    label        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'idle',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_terminals_task ON user_terminals(task_id);
CREATE INDEX IF NOT EXISTS idx_agents_claude_session_id ON agents(claude_session_id);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status_created ON permission_prompts(agent_id, status, created_at);

CREATE TABLE IF NOT EXISTS repo_configs (
    repo_path       TEXT PRIMARY KEY,
    base_branch     TEXT,
    test_command    TEXT NOT NULL DEFAULT 'bun run test',
    format_command  TEXT NOT NULL DEFAULT 'bun run format',
    lint_command    TEXT NOT NULL DEFAULT 'bun run lint:fix',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    github_login    TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });

    // In production, check for database at old package-relative location
    if (isProduction && OLD_DB_PATH !== DB_PATH && fs.existsSync(OLD_DB_PATH)) {
      logger.info(
        { old_path: OLD_DB_PATH, new_path: DB_PATH },
        'Found database at old location — copy to new location to migrate',
      );
    }

    db = new Database(DB_PATH);
    initDb(db);
  }
  return db;
}

/** Replace the singleton db instance (for testing). */
export function setDb(instance: Database.Database): void {
  db = instance;
}

/** Initialize a database with schema and pragmas. */
export function initDb(instance: Database.Database): void {
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.exec(SCHEMA);

  const columnsOf = (table: string): Set<string> => {
    const rows = instance.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return new Set(rows.map((c) => c.name));
  };
  const addColumn = (table: string, name: string, ddl: string, cols: Set<string>): void => {
    if (!cols.has(name)) {
      instance.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      cols.add(name);
    }
  };

  // Additive migrations — idempotent, one read per table
  const taskCols = columnsOf('tasks');
  addColumn('tasks', 'initial_prompt', 'initial_prompt TEXT', taskCols);
  addColumn('tasks', 'base_branch', 'base_branch TEXT', taskCols);
  addColumn('tasks', 'user_window_index', 'user_window_index INTEGER', taskCols);
  // Legacy column; dropped by run_mode migration below if present.
  addColumn('tasks', 'no_worktree', 'no_worktree INTEGER NOT NULL DEFAULT 0', taskCols);
  addColumn('tasks', 'source', 'source TEXT', taskCols);
  addColumn('tasks', 'pr_head_sha', 'pr_head_sha TEXT', taskCols);
  addColumn('tasks', 'base_sha', 'base_sha TEXT', taskCols);
  addColumn('tasks', 'last_viewed_at', 'last_viewed_at TEXT', taskCols);

  const agentCols = columnsOf('agents');
  addColumn('agents', 'claude_session_id', 'claude_session_id TEXT', agentCols);
  addColumn('agents', 'hook_activity', "hook_activity TEXT NOT NULL DEFAULT 'active'", agentCols);
  addColumn('agents', 'hook_activity_updated_at', 'hook_activity_updated_at TEXT', agentCols);

  // ─── run_mode migration ───────────────────────────────────────────────
  // Introduce run_mode, backfill from legacy no_worktree + repo_path, drop
  // no_worktree. One transaction so a crash mid-migration can't leave a
  // half-shaped schema.
  if (taskCols.has('no_worktree') || !taskCols.has('run_mode')) {
    instance
      .transaction(() => {
        if (!taskCols.has('run_mode')) {
          instance.exec(`ALTER TABLE tasks ADD COLUMN run_mode TEXT`);
          taskCols.add('run_mode');
        }

        if (taskCols.has('no_worktree')) {
          instance.exec(`
            UPDATE tasks SET run_mode = CASE
              WHEN no_worktree = 1 AND (repo_path IS NULL OR repo_path = '') THEN 'scratch'
              WHEN no_worktree = 1                                            THEN 'none'
              ELSE                                                                 'new'
            END
            WHERE run_mode IS NULL
          `);
        } else {
          instance.exec(`UPDATE tasks SET run_mode = 'new' WHERE run_mode IS NULL`);
        }

        if (taskCols.has('no_worktree')) {
          instance.exec(`ALTER TABLE tasks DROP COLUMN no_worktree`);
          taskCols.delete('no_worktree');
        }
      })
      .default();
  }

  // Partial unique indexes: DB-enforced safety matrix (prevents app-level TOCTOU).
  instance.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_existing_path
       ON tasks(worktree)
       WHERE run_mode = 'existing' AND status IN ('setting_up','running')`,
  );
  instance.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_none_repo
       ON tasks(repo_path)
       WHERE run_mode = 'none' AND status IN ('setting_up','running')`,
  );

  // Data migrations
  instance.exec(`UPDATE tasks SET status = 'draft' WHERE status = 'created'`);

  // Resolve stale pending prompts and reset agents stuck in 'waiting'
  // (hook callbacks lost during the previous run's shutdown)
  instance.exec(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`,
  );
  instance.exec(
    `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
     WHERE hook_activity = 'waiting' AND status = 'running'`,
  );
}
