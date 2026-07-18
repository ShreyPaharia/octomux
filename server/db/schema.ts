import type Database from 'better-sqlite3';

export const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS tasks (
    id                           TEXT PRIMARY KEY,
    title                        TEXT NOT NULL,
    description                  TEXT NOT NULL,
    runtime_state                TEXT NOT NULL DEFAULT 'idle',
    workflow_status              TEXT NOT NULL DEFAULT 'backlog',
    worktree_id                  TEXT REFERENCES worktrees(id),
    tmux_session                 TEXT,
    pr_url                       TEXT,
    pr_number                    INTEGER,
    pr_head_sha                  TEXT,
    user_window_index            INTEGER,
    initial_prompt               TEXT,
    last_viewed_at               TEXT,
    source                       TEXT,
    schedule_id                  TEXT,
    error                        TEXT,
    current_summary              TEXT,
    current_summary_updated_at   TEXT,
    harness_id                   TEXT NOT NULL DEFAULT 'claude-code',
    deleted_at                   TEXT,
    created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_updates (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  body        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_updates_task_created ON task_updates(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_external_refs (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  integration TEXT NOT NULL,
  ref         TEXT NOT NULL,
  url         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, integration)
);

CREATE TABLE IF NOT EXISTS integrations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    task_id           TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    window_index      INTEGER NOT NULL,
    label             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'running',
    harness_session_id TEXT,
    harness_id        TEXT NOT NULL DEFAULT 'claude-code',
    hook_token        TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permission_prompts (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    agent_id   TEXT,
    session_id TEXT,
    tool_name  TEXT NOT NULL,
    tool_input TEXT NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS file_review_state (
    task_id            TEXT NOT NULL,
    file_path          TEXT NOT NULL,
    reviewed_at        TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at_commit TEXT NOT NULL,
    PRIMARY KEY (task_id, file_path),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_review_state_task ON file_review_state(task_id);

CREATE TABLE IF NOT EXISTS config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    github_login    TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inline_comments (
    id                   TEXT PRIMARY KEY,
    task_id              TEXT NOT NULL,
    agent_id             TEXT,
    file_path            TEXT NOT NULL,
    line                 INTEGER NOT NULL,
    side                 TEXT NOT NULL CHECK(side IN ('old','new')),
    original_commit_sha  TEXT NOT NULL,
    body                 TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at          TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inline_comments_task_file
    ON inline_comments(task_id, file_path);

CREATE TABLE IF NOT EXISTS hook_settings (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  cron          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  config_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, repo_path)
);

`;

/** Apply SQLite pragmas required for octomux (WAL + foreign keys). */
export function applyPragmas(instance: Database.Database): void {
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
}
