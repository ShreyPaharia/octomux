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
    error                        TEXT,
    current_summary              TEXT,
    current_summary_updated_at   TEXT,
    harness_id                   TEXT NOT NULL DEFAULT 'claude-code',
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

`;

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
      const oldCols = (instance.pragma('table_info(agents)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      const has = (c: string) => oldCols.includes(c);

      instance.exec(`
        CREATE TABLE agents_new (
          id                       TEXT PRIMARY KEY,
          task_id                  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          window_index             INTEGER NOT NULL,
          label                    TEXT NOT NULL,
          status                   TEXT NOT NULL DEFAULT 'running',
          harness_session_id       TEXT,
          hook_activity            TEXT NOT NULL DEFAULT 'active',
          hook_activity_updated_at TEXT,
          harness_id               TEXT NOT NULL DEFAULT 'claude-code',
          hook_token               TEXT NOT NULL DEFAULT '',
          created_at               TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const selectCols = [
        'id',
        'task_id',
        'window_index',
        'label',
        'status',
        has('harness_session_id') ? 'harness_session_id' : 'NULL AS harness_session_id',
        has('hook_activity') ? 'hook_activity' : `'active' AS hook_activity`,
        has('hook_activity_updated_at')
          ? 'hook_activity_updated_at'
          : 'NULL AS hook_activity_updated_at',
        has('harness_id') ? 'harness_id' : `'claude-code' AS harness_id`,
        has('hook_token') ? 'hook_token' : `'' AS hook_token`,
        'created_at',
      ].join(', ');

      instance.exec(`INSERT INTO agents_new SELECT ${selectCols} FROM agents`);
      instance.exec(`DROP TABLE agents`);
      instance.exec(`ALTER TABLE agents_new RENAME TO agents`);

      // Recreate indexes (idempotent CREATE IF NOT EXISTS).
      instance.exec(`CREATE INDEX IF NOT EXISTS idx_agents_task ON agents(task_id)`);
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_agents_harness_session_id ON agents(harness_session_id)`,
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
    // Restrict DB file to owner-only access to protect stored credentials.
    try {
      fs.chmodSync(DB_PATH, 0o600);
    } catch {
      // Best-effort — may fail on non-POSIX systems or virtual filesystems.
    }
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

  // Additive migrations — idempotent, one read per table.
  // Columns added here are ones still present on the current schema; legacy
  // columns (worktree, run_mode, repo_path, branch, base_branch, base_sha)
  // were dropped after Phase 2a and are re-homed in the worktrees table.
  const taskCols = columnsOf('tasks');

  const agentCols = columnsOf('agents');

  // Rename agents.claude_session_id -> agents.harness_session_id (step-1 of
  // the harness abstraction). Must run BEFORE addColumn for harness_session_id
  // so the rename fires on old DBs before we try to add the new-named column.
  // Idempotent: only runs when the old column still exists.
  // SQLite 3.25+ supports RENAME COLUMN.
  if (agentCols.has('claude_session_id') && !agentCols.has('harness_session_id')) {
    instance.exec(`ALTER TABLE agents RENAME COLUMN claude_session_id TO harness_session_id`);
    instance.exec(`DROP INDEX IF EXISTS idx_agents_claude_session_id`);
    agentCols.delete('claude_session_id');
    agentCols.add('harness_session_id');
  }

  addColumn('agents', 'harness_session_id', 'harness_session_id TEXT', agentCols);
  addColumn('agents', 'hook_activity', "hook_activity TEXT NOT NULL DEFAULT 'active'", agentCols);
  addColumn('agents', 'hook_activity_updated_at', 'hook_activity_updated_at TEXT', agentCols);
  addColumn('agents', 'harness_id', `harness_id TEXT NOT NULL DEFAULT 'claude-code'`, agentCols);
  addColumn('agents', 'hook_token', `hook_token TEXT NOT NULL DEFAULT ''`, agentCols);

  // Ensure the index exists (created here rather than SCHEMA to avoid ordering
  // issues when the old column is still named claude_session_id at SCHEMA time).
  instance.exec(
    `CREATE INDEX IF NOT EXISTS idx_agents_harness_session_id ON agents(harness_session_id)`,
  );

  // ─── Legacy pre-Phase-2a shim: add run_mode / backfill from no_worktree ──
  // Needed only for very old DBs that predate run_mode. The Phase 2a backfill
  // below expects tasks.run_mode to exist.
  if (taskCols.has('no_worktree') && !taskCols.has('run_mode')) {
    instance
      .transaction(() => {
        instance.exec(`ALTER TABLE tasks ADD COLUMN run_mode TEXT`);
        taskCols.add('run_mode');
        instance.exec(`
          UPDATE tasks SET run_mode = CASE
            WHEN no_worktree = 1 AND (repo_path IS NULL OR repo_path = '') THEN 'scratch'
            WHEN no_worktree = 1                                            THEN 'none'
            ELSE                                                                 'new'
          END
          WHERE run_mode IS NULL
        `);
        instance.exec(`ALTER TABLE tasks DROP COLUMN no_worktree`);
        taskCols.delete('no_worktree');
      })
      .default();
  } else if (taskCols.has('no_worktree')) {
    // run_mode already exists; backfill it from no_worktree for any NULL rows,
    // then drop the dead column.
    instance
      .transaction(() => {
        instance.exec(`
          UPDATE tasks SET run_mode = CASE
            WHEN no_worktree = 1 AND (repo_path IS NULL OR repo_path = '') THEN 'scratch'
            WHEN no_worktree = 1                                            THEN 'none'
            ELSE                                                                 'new'
          END
          WHERE run_mode IS NULL
        `);
        instance.exec(`ALTER TABLE tasks DROP COLUMN no_worktree`);
        taskCols.delete('no_worktree');
      })
      .default();
  }

  // ─── Phase 2a migration: worktrees entity + agents.task_id nullable ──────
  // Additive shape: introduces `worktrees` table, `tasks.worktree_id`,
  // `agents.pinned`, `agents.tmux_session`, and nullable `agents.task_id`.
  // Legacy columns on `tasks` (worktree, run_mode, etc.) remain for now;
  // a later phase rewrites consumers then drops them.
  const agentFk = agentFkIsNotNull(instance);
  // Only run the backfill if the legacy `worktree` column still exists on
  // tasks — on fresh DBs it's already gone and there's nothing to backfill.
  const canBackfill = taskCols.has('worktree');
  {
    instance
      .transaction(() => {
        if (!taskCols.has('worktree_id')) {
          instance.exec(`ALTER TABLE tasks ADD COLUMN worktree_id TEXT REFERENCES worktrees(id)`);
          taskCols.add('worktree_id');
        }

        if (!canBackfill) return;

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
        const linkTask = instance.prepare(`UPDATE tasks SET worktree_id = ? WHERE id = ?`);

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

  // Add agents.tmux_session column (post-rebuild).
  const agentCols2 = columnsOf('agents');
  addColumn('agents', 'tmux_session', 'tmux_session TEXT', agentCols2);
  addColumn('agents', 'agent', 'agent TEXT', agentCols2);
  // Drop legacy `pinned` column from older installs (carried the singleton
  // orchestrator row). SQLite >= 3.35 supports DROP COLUMN.
  if (agentCols2.has('pinned')) {
    instance.exec(`ALTER TABLE agents DROP COLUMN pinned`);
    agentCols2.delete('pinned');
  }

  // Add tasks.agent column (idempotent).
  const taskColsForAgent = columnsOf('tasks');
  addColumn('tasks', 'agent', 'agent TEXT', taskColsForAgent);
  addColumn(
    'tasks',
    'harness_id',
    `harness_id TEXT NOT NULL DEFAULT 'claude-code'`,
    taskColsForAgent,
  );

  // ─── Drop legacy columns from tasks ──────────────────────────────────────
  // Worktrees is now the source of truth. SQLite has DROP COLUMN (>= 3.35),
  // but partial indexes pinned to those columns must be dropped first.
  const currentTaskCols = columnsOf('tasks');
  const legacyCols = [
    'worktree',
    'run_mode',
    'repo_path',
    'branch',
    'base_branch',
    'base_sha',
  ] as const;
  if (legacyCols.some((c) => currentTaskCols.has(c))) {
    instance
      .transaction(() => {
        instance.exec(`DROP INDEX IF EXISTS idx_tasks_existing_path`);
        instance.exec(`DROP INDEX IF EXISTS idx_tasks_none_repo`);
        for (const col of legacyCols) {
          if (currentTaskCols.has(col)) {
            instance.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
          }
        }
      })
      .default();
  }

  // Drop old partial unique index first (it referenced status; we'll recreate
  // it after runtime_state column is guaranteed to exist).
  instance.exec(`DROP INDEX IF EXISTS idx_tasks_active_worktree`);

  // Drop the legacy seeded orchestrator agent row from older installs.
  instance.prepare(`DELETE FROM agents WHERE id = 'orchestrator' AND task_id IS NULL`).run();

  // ─── Workflow / runtime_state migration ───────────────────────────────────
  // Add new columns to tasks if they don't exist yet (pre-wave-1 DBs).
  const taskColsV2 = columnsOf('tasks');
  addColumn('tasks', 'runtime_state', `runtime_state TEXT NOT NULL DEFAULT 'idle'`, taskColsV2);
  addColumn(
    'tasks',
    'workflow_status',
    `workflow_status TEXT NOT NULL DEFAULT 'backlog'`,
    taskColsV2,
  );
  addColumn('tasks', 'current_summary', 'current_summary TEXT', taskColsV2);
  addColumn('tasks', 'current_summary_updated_at', 'current_summary_updated_at TEXT', taskColsV2);

  // Backfill workflow_status from initial_prompt + pr_url for old rows that
  // still have the default 'backlog' and no context to derive from.
  // The status-based backfill was removed in Wave 4 (status column dropped).
  const taskColsV2Check = columnsOf('tasks');
  if (taskColsV2Check.has('workflow_status')) {
    instance.exec(`
      UPDATE tasks SET workflow_status = CASE
        WHEN runtime_state IN ('running', 'setting_up', 'error') THEN 'in_progress'
        WHEN runtime_state = 'idle' AND initial_prompt IS NULL   THEN 'backlog'
        WHEN runtime_state = 'idle' AND initial_prompt IS NOT NULL THEN 'planned'
        WHEN pr_url IS NOT NULL                                  THEN 'pr'
        ELSE 'backlog'
      END
      WHERE workflow_status = 'backlog'
    `);
  }

  // ─── ref_inference_json column on repo_configs (Wave 3) ──────────────────
  const repoConfigCols = columnsOf('repo_configs');
  addColumn('repo_configs', 'ref_inference_json', 'ref_inference_json TEXT', repoConfigCols);

  // ─── New tables (task_updates, task_external_refs, integrations) ──────────
  // These are already created in SCHEMA above via CREATE TABLE IF NOT EXISTS,
  // but for old DBs that ran SCHEMA before this migration block, we ensure
  // the tables exist now by trying to create them if absent.
  const existingTables = new Set(
    (
      instance.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  if (!existingTables.has('task_updates')) {
    instance.exec(`
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
    `);
  }
  if (!existingTables.has('task_external_refs')) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS task_external_refs (
        task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        integration TEXT NOT NULL,
        ref         TEXT NOT NULL,
        url         TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, integration)
      );
    `);
  }
  if (!existingTables.has('integrations')) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  if (!existingTables.has('hook_settings')) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS hook_settings (
        scope      TEXT NOT NULL,
        key        TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope, key)
      );
    `);
  }

  // ─── Wave 4: drop legacy tasks.status column ────────────────────────────
  // Backfill any tasks where runtime_state is NULL from the legacy status
  // column (one-shot safety net for very old DBs), then drop the column.
  const taskColsV4 = columnsOf('tasks');
  if (taskColsV4.has('status')) {
    instance
      .transaction(() => {
        // Safety backfill: if runtime_state somehow got NULL, restore from status.
        instance.exec(`
          UPDATE tasks SET runtime_state = CASE
            WHEN status = 'setting_up' THEN 'setting_up'
            WHEN status = 'running'    THEN 'running'
            WHEN status = 'error'      THEN 'error'
            ELSE                            'idle'
          END
          WHERE runtime_state IS NULL
        `);
        // Drop the index that referenced status, then the column itself.
        instance.exec(`DROP INDEX IF EXISTS idx_tasks_status`);
        instance.exec(`ALTER TABLE tasks DROP COLUMN status`);
      })
      .default();
  }

  // Partial unique index keyed to worktree_id — now uses runtime_state.
  // Created here (after column migration) to ensure runtime_state exists.
  instance.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_worktree
       ON tasks(worktree_id)
       WHERE runtime_state IN ('setting_up','running') AND worktree_id IS NOT NULL`,
  );

  // ─── Relax permission_prompts.session_id NOT NULL → nullable ─────────────
  // Required for step 2 (harness-issued session ids): prompts may be created
  // before the session id is bound. Idempotent: gated on the current column
  // nullability via PRAGMA. SQLite can't ALTER a NOT NULL in-place; table
  // rebuild is the only safe path.
  const ppCols = instance.pragma('table_info(permission_prompts)') as Array<{
    name: string;
    notnull: number;
  }>;
  const sidCol = ppCols.find((c) => c.name === 'session_id');
  if (sidCol && sidCol.notnull === 1) {
    instance
      .transaction(() => {
        instance.exec(`ALTER TABLE permission_prompts RENAME TO permission_prompts_old`);
        instance.exec(`
          CREATE TABLE permission_prompts (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            agent_id    TEXT,
            session_id  TEXT,
            tool_name   TEXT NOT NULL,
            tool_input  TEXT NOT NULL DEFAULT '{}',
            status      TEXT NOT NULL DEFAULT 'pending',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
          )
        `);
        instance.exec(`INSERT INTO permission_prompts SELECT * FROM permission_prompts_old`);
        instance.exec(`DROP TABLE permission_prompts_old`);
        instance.exec(
          `CREATE INDEX IF NOT EXISTS idx_permission_prompts_task_id ON permission_prompts(task_id)`,
        );
        instance.exec(
          `CREATE INDEX IF NOT EXISTS idx_permission_prompts_status ON permission_prompts(status)`,
        );
        instance.exec(
          `CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status ON permission_prompts(agent_id, status)`,
        );
        instance.exec(
          `CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status_created ON permission_prompts(agent_id, status, created_at)`,
        );
      })
      .default();
  }

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
