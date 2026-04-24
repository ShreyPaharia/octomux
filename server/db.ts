import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { nanoid } from 'nanoid';
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

CREATE TABLE IF NOT EXISTS worktrees (
    id            TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    repo_path     TEXT,
    branch        TEXT,
    base_branch   TEXT,
    base_sha      TEXT,
    mode          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'available',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_worktrees_path ON worktrees(path);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
`;

/** Well-known id for the pinned orchestrator agent row. */
export const ORCHESTRATOR_AGENT_ID = 'orchestrator';
/** Tmux session name for the orchestrator agent. */
export const ORCHESTRATOR_TMUX_SESSION = 'octomux-orchestrator';

/**
 * Returns true when the live `agents.task_id` column is declared NOT NULL.
 * Used to trigger the nullable-task_id migration exactly once.
 */
function agentFkIsNotNull(instance: Database.Database): boolean {
  const rows = instance.pragma('table_info(agents)') as Array<{
    name: string;
    notnull: number;
  }>;
  const col = rows.find((c) => c.name === 'task_id');
  return !!col && col.notnull === 1;
}

/**
 * Rebuild the `agents` table to make `task_id` nullable while preserving rows,
 * FK, cascade behaviour, and indexes. SQLite < 3.35 can't ALTER a column's
 * NOT NULL in place; a table rebuild is the supported path.
 */
function rebuildAgentsTable(instance: Database.Database): void {
  instance
    .transaction(() => {
      // Capture dynamically-added columns that may not exist in the CREATE.
      const oldCols = (
        instance.pragma('table_info(agents)') as Array<{ name: string }>
      ).map((c) => c.name);
      const has = (c: string) => oldCols.includes(c);

      instance.exec(`
        CREATE TABLE agents_new (
          id                       TEXT PRIMARY KEY,
          task_id                  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          window_index             INTEGER NOT NULL,
          label                    TEXT NOT NULL,
          status                   TEXT NOT NULL DEFAULT 'running',
          claude_session_id        TEXT,
          hook_activity            TEXT NOT NULL DEFAULT 'active',
          hook_activity_updated_at TEXT,
          created_at               TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const selectCols = [
        'id',
        'task_id',
        'window_index',
        'label',
        'status',
        has('claude_session_id') ? 'claude_session_id' : 'NULL AS claude_session_id',
        has('hook_activity') ? 'hook_activity' : `'active' AS hook_activity`,
        has('hook_activity_updated_at')
          ? 'hook_activity_updated_at'
          : 'NULL AS hook_activity_updated_at',
        'created_at',
      ].join(', ');

      instance.exec(`INSERT INTO agents_new SELECT ${selectCols} FROM agents`);
      instance.exec(`DROP TABLE agents`);
      instance.exec(`ALTER TABLE agents_new RENAME TO agents`);

      // Recreate indexes (idempotent CREATE IF NOT EXISTS).
      instance.exec(`CREATE INDEX IF NOT EXISTS idx_agents_task ON agents(task_id)`);
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_agents_claude_session_id ON agents(claude_session_id)`,
      );
    })
    .default();
}

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

  // ─── Phase 2a migration: worktrees entity + agents.task_id nullable ──────
  // Additive shape: introduces `worktrees` table, `tasks.worktree_id`,
  // `agents.pinned`, `agents.tmux_session`, and nullable `agents.task_id`.
  // Legacy columns on `tasks` (worktree, run_mode, etc.) remain for now;
  // a later phase rewrites consumers then drops them.
  const agentFk = agentFkIsNotNull(instance);
  {
    instance
      .transaction(() => {
        if (!taskCols.has('worktree_id')) {
          instance.exec(`ALTER TABLE tasks ADD COLUMN worktree_id TEXT REFERENCES worktrees(id)`);
          taskCols.add('worktree_id');
        }

        // Backfill worktrees for any task that has a worktree path but no link.
        const rows = instance
          .prepare(
            `SELECT id, repo_path, branch, base_branch, base_sha, worktree, run_mode, created_at
               FROM tasks
              WHERE worktree IS NOT NULL AND worktree_id IS NULL`,
          )
          .all() as Array<{
          id: string;
          repo_path: string | null;
          branch: string | null;
          base_branch: string | null;
          base_sha: string | null;
          worktree: string | null;
          run_mode: string | null;
          created_at: string;
        }>;

        const insertWt = instance.prepare(
          `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'in_use', ?)`,
        );
        const linkTask = instance.prepare(
          `UPDATE tasks SET worktree_id = ? WHERE id = ?`,
        );

        for (const r of rows) {
          const wtId = nanoid(12);
          const mode = r.run_mode || 'new';
          // scratch tasks: repo_path/branch/etc may be absent by design.
          const repoPath = mode === 'scratch' ? null : r.repo_path;
          const branch = mode === 'scratch' ? null : r.branch;
          const baseBranch = mode === 'scratch' ? null : r.base_branch;
          const baseSha = mode === 'scratch' ? null : r.base_sha;
          insertWt.run(
            wtId,
            r.worktree!,
            repoPath,
            branch,
            baseBranch,
            baseSha,
            mode,
            r.created_at,
          );
          linkTask.run(wtId, r.id);
        }
      })
      .default();
  }

  // Make agents.task_id nullable via table rebuild if currently NOT NULL.
  if (agentFk) {
    rebuildAgentsTable(instance);
  }

  // Add agents.pinned and agents.tmux_session columns (post-rebuild).
  const agentCols2 = columnsOf('agents');
  addColumn('agents', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0', agentCols2);
  addColumn('agents', 'tmux_session', 'tmux_session TEXT', agentCols2);

  // New partial unique index keyed to worktree_id (complements legacy ones).
  instance.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_worktree
       ON tasks(worktree_id)
       WHERE status IN ('draft','setting_up','running') AND worktree_id IS NOT NULL`,
  );

  // Ensure orchestrator pinned agent row exists (idempotent).
  instance
    .prepare(
      `INSERT OR IGNORE INTO agents
         (id, task_id, window_index, label, status, hook_activity, pinned, tmux_session, created_at)
       VALUES (?, NULL, 0, 'orchestrator', 'idle', 'active', 1, ?, datetime('now'))`,
    )
    .run(ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_TMUX_SESSION);

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
