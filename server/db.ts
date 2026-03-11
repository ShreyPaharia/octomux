import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'tasks.db');

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
`;

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
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

  // Migrations
  const cols = instance.pragma('table_info(tasks)') as Array<{ name: string }>;
  const colNames = cols.map((c) => c.name);
  if (!colNames.includes('initial_prompt')) {
    instance.exec('ALTER TABLE tasks ADD COLUMN initial_prompt TEXT');
  }

  // Add claude_session_id to agents table (for existing DBs)
  const agentCols = instance.pragma('table_info(agents)') as Array<{ name: string }>;
  const agentColNames = agentCols.map((c) => c.name);
  if (!agentColNames.includes('claude_session_id')) {
    instance.exec('ALTER TABLE agents ADD COLUMN claude_session_id TEXT');
  }
  if (!colNames.includes('base_branch')) {
    instance.exec('ALTER TABLE tasks ADD COLUMN base_branch TEXT');
  }
  if (!colNames.includes('user_window_index')) {
    instance.exec('ALTER TABLE tasks ADD COLUMN user_window_index INTEGER');
  }

  // Add hook_activity columns to agents table (for existing DBs)
  if (!agentColNames.includes('hook_activity')) {
    instance.exec("ALTER TABLE agents ADD COLUMN hook_activity TEXT NOT NULL DEFAULT 'active'");
    instance.exec('ALTER TABLE agents ADD COLUMN hook_activity_updated_at TEXT');
  }

  // Resolve any stale pending permission prompts from previous run
  // and reset agents stuck in 'waiting' state (hooks lost during restart)
  instance.exec(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`,
  );
  instance.exec(
    `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
     WHERE hook_activity = 'waiting' AND status = 'running'`,
  );
}
