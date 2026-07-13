import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { childLogger } from '../logger.js';

const logger = childLogger('db');

export function columnsOf(instance: Database.Database, table: string): Set<string> {
  const rows = instance.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((c) => c.name));
}

export function addColumn(
  instance: Database.Database,
  table: string,
  name: string,
  ddl: string,
  cols: Set<string>,
): void {
  if (!cols.has(name)) {
    instance.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    cols.add(name);
  }
}

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

/** Run forward-only additive migrations on an initialized database. */
export function runMigrations(instance: Database.Database): void {
  // Additive migrations — idempotent, one read per table.
  // Columns added here are ones still present on the current schema; legacy
  // columns (worktree, run_mode, repo_path, branch, base_branch, base_sha)
  // were dropped after Phase 2a and are re-homed in the worktrees table.
  const taskCols = columnsOf(instance, 'tasks');

  const agentCols = columnsOf(instance, 'agents');

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

  addColumn(instance, 'agents', 'harness_session_id', 'harness_session_id TEXT', agentCols);
  addColumn(
    instance,
    'agents',
    'hook_activity',
    "hook_activity TEXT NOT NULL DEFAULT 'active'",
    agentCols,
  );
  addColumn(
    instance,
    'agents',
    'hook_activity_updated_at',
    'hook_activity_updated_at TEXT',
    agentCols,
  );
  addColumn(
    instance,
    'agents',
    'harness_id',
    `harness_id TEXT NOT NULL DEFAULT 'claude-code'`,
    agentCols,
  );
  addColumn(instance, 'agents', 'hook_token', `hook_token TEXT NOT NULL DEFAULT ''`, agentCols);

  const taskRefCols = columnsOf(instance, 'task_external_refs');
  addColumn(instance, 'task_external_refs', 'metadata', 'metadata TEXT', taskRefCols);

  // reviewed_blob_sha records the git blob hash of the file content a reviewer
  // approved (working-tree content), so "changed since review" can detect both
  // new commits and uncommitted edits. Null on legacy rows → callers fall back
  // to the commit-blob comparison.
  const fileReviewCols = columnsOf(instance, 'file_review_state');
  addColumn(
    instance,
    'file_review_state',
    'reviewed_blob_sha',
    'reviewed_blob_sha TEXT',
    fileReviewCols,
  );

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
  const agentCols2 = columnsOf(instance, 'agents');
  addColumn(instance, 'agents', 'tmux_session', 'tmux_session TEXT', agentCols2);
  addColumn(instance, 'agents', 'agent', 'agent TEXT', agentCols2);
  // Drop legacy `pinned` column from older installs (carried the singleton
  // orchestrator row). SQLite >= 3.35 supports DROP COLUMN.
  if (agentCols2.has('pinned')) {
    instance.exec(`ALTER TABLE agents DROP COLUMN pinned`);
    agentCols2.delete('pinned');
  }

  // Add tasks.agent column (idempotent).
  const taskColsForAgent = columnsOf(instance, 'tasks');
  addColumn(instance, 'tasks', 'agent', 'agent TEXT', taskColsForAgent);
  addColumn(
    instance,
    'tasks',
    'harness_id',
    `harness_id TEXT NOT NULL DEFAULT 'claude-code'`,
    taskColsForAgent,
  );
  addColumn(instance, 'tasks', 'model', 'model TEXT', taskColsForAgent);

  // ─── Drop legacy columns from tasks ──────────────────────────────────────
  // Worktrees is now the source of truth. SQLite has DROP COLUMN (>= 3.35),
  // but partial indexes pinned to those columns must be dropped first.
  const currentTaskCols = columnsOf(instance, 'tasks');
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
  const taskColsV2 = columnsOf(instance, 'tasks');
  addColumn(
    instance,
    'tasks',
    'runtime_state',
    `runtime_state TEXT NOT NULL DEFAULT 'idle'`,
    taskColsV2,
  );
  addColumn(
    instance,
    'tasks',
    'workflow_status',
    `workflow_status TEXT NOT NULL DEFAULT 'backlog'`,
    taskColsV2,
  );
  addColumn(instance, 'tasks', 'current_summary', 'current_summary TEXT', taskColsV2);
  addColumn(
    instance,
    'tasks',
    'current_summary_updated_at',
    'current_summary_updated_at TEXT',
    taskColsV2,
  );
  addColumn(instance, 'tasks', 'deleted_at', 'deleted_at TEXT', taskColsV2);
  addColumn(instance, 'tasks', 'notify_task_id', 'notify_task_id TEXT', taskColsV2);

  // Partial index for the purge poller's hot path.
  instance.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at
         ON tasks(deleted_at) WHERE deleted_at IS NOT NULL`,
  );

  // Migrate legacy 'archived' workflow_status rows into the new trash flow.
  // Idempotent: only updates rows that still have workflow_status='archived'.
  // Uses datetime('now') (not updated_at) so users get a full grace window
  // post-upgrade to restore anything they actually wanted to keep.
  const archivedCount = (
    instance
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workflow_status = 'archived'`)
      .get() as { n: number }
  ).n;
  if (archivedCount > 0) {
    instance
      .prepare(
        `UPDATE tasks SET workflow_status = 'done',
                         deleted_at      = datetime('now'),
                         updated_at      = datetime('now')
         WHERE workflow_status = 'archived'`,
      )
      .run();
    logger.warn(
      { migrated: archivedCount },
      'migrated legacy archived tasks to trash; will purge after deleteGraceHours',
    );
  }

  // Backfill workflow_status from initial_prompt + pr_url for old rows that
  // still have the default 'backlog' and no context to derive from.
  // The status-based backfill was removed in Wave 4 (status column dropped).
  const taskColsV2Check = columnsOf(instance, 'tasks');
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
  const repoConfigCols = columnsOf(instance, 'repo_configs');
  addColumn(
    instance,
    'repo_configs',
    'ref_inference_json',
    'ref_inference_json TEXT',
    repoConfigCols,
  );

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
  const taskColsV4 = columnsOf(instance, 'tasks');
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

  // ── Review orchestrator (2026-05-28) ─────────────────────────────────────

  instance.exec(`
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      pr_head_sha TEXT NOT NULL,
      walkthrough TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMP NOT NULL DEFAULT (datetime('now')),
      completed_at TIMESTAMP,
      error TEXT,
      deep_review_attached INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_task ON review_runs(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_task_sha_status
      ON review_runs(task_id, pr_head_sha)
      WHERE status IN ('running', 'completed');

    CREATE TABLE IF NOT EXISTS published_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      github_review_id INTEGER NOT NULL,
      github_review_url TEXT,
      head_sha TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'COMMENT',
      comment_count INTEGER NOT NULL,
      published_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_published_reviews_task ON published_reviews(task_id);

    CREATE TABLE IF NOT EXISTS review_learnings (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      why TEXT NOT NULL,
      created_from_comment_id TEXT REFERENCES inline_comments(id) ON DELETE SET NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_learnings_repo ON review_learnings(repo_path);
  `);

  const reviewRunCols = columnsOf(instance, 'review_runs');
  addColumn(
    instance,
    'review_runs',
    'deep_review_attached',
    'deep_review_attached INTEGER NOT NULL DEFAULT 0',
    reviewRunCols,
  );

  const inlineCommentCols = columnsOf(instance, 'inline_comments');
  addColumn(
    instance,
    'inline_comments',
    'status',
    `status TEXT NOT NULL DEFAULT 'draft'`,
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'review_run_id',
    'review_run_id TEXT REFERENCES review_runs(id)',
    inlineCommentCols,
  );
  addColumn(instance, 'inline_comments', 'severity', 'severity TEXT', inlineCommentCols);
  addColumn(instance, 'inline_comments', 'bucket', 'bucket TEXT', inlineCommentCols);
  addColumn(
    instance,
    'inline_comments',
    'kind',
    `kind TEXT NOT NULL DEFAULT 'comment'`,
    inlineCommentCols,
  );
  addColumn(instance, 'inline_comments', 'existing_code', 'existing_code TEXT', inlineCommentCols);
  addColumn(
    instance,
    'inline_comments',
    'suggested_code',
    'suggested_code TEXT',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'published_review_id',
    'published_review_id TEXT REFERENCES published_reviews(id)',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'github_comment_id',
    'github_comment_id INTEGER',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    're_flag_of',
    're_flag_of TEXT REFERENCES inline_comments(id)',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'last_check_run_id',
    'last_check_run_id TEXT REFERENCES review_runs(id)',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'last_check_status',
    'last_check_status TEXT',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'auto_resolved_at',
    'auto_resolved_at TIMESTAMP',
    inlineCommentCols,
  );
  addColumn(
    instance,
    'inline_comments',
    'auto_resolved_reason',
    'auto_resolved_reason TEXT',
    inlineCommentCols,
  );

  // ── Manual review trigger: link review tasks back to their source task ──
  // Nullable so poller-created reviews (which review a PR, not a source task)
  // can leave it NULL. ON DELETE SET NULL so removing a source task doesn't
  // cascade-delete its review.
  const taskColsForReviewLink = columnsOf(instance, 'tasks');
  addColumn(
    instance,
    'tasks',
    'review_of_task_id',
    'review_of_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL',
    taskColsForReviewLink,
  );
  instance.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_review_of_task_id
       ON tasks(review_of_task_id) WHERE review_of_task_id IS NOT NULL`,
  );

  // ── Intra-task sub-agents: notify_agent_id on agents (2026-06-11) ──────────
  // When a sub-agent completes, its parent agent is notified via this link.
  const agentCols3 = columnsOf(instance, 'agents');
  addColumn(instance, 'agents', 'notify_agent_id', 'notify_agent_id TEXT', agentCols3);

  // ── Orchestrator chat tables (2026-06-20, SHR-117) ───────────────────────
  // Forward-only; all created via CREATE TABLE IF NOT EXISTS for idempotency.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_conversations (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      tmux_window       TEXT,
      claude_session_id TEXT,
      transcript_path   TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orch_conversations_status
      ON orchestrator_conversations(status);

    CREATE TABLE IF NOT EXISTS orchestrator_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES orchestrator_conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orch_messages_conversation
      ON orchestrator_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS action_cards (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES orchestrator_conversations(id) ON DELETE CASCADE,
      tool_use_id     TEXT NOT NULL,
      tool_name       TEXT NOT NULL,
      input           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      result          TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_cards_conversation
      ON action_cards(conversation_id, status);

    CREATE TABLE IF NOT EXISTS permission_rules (
      id         TEXT PRIMARY KEY,
      tool_name  TEXT NOT NULL,
      match      TEXT,
      effect     TEXT NOT NULL DEFAULT 'allow',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_usage (
      conversation_id  TEXT PRIMARY KEY REFERENCES orchestrator_conversations(id) ON DELETE CASCADE,
      tasks_spawned    INTEGER NOT NULL DEFAULT 0,
      tool_calls       INTEGER NOT NULL DEFAULT 0,
      started_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS managed_tasks (
      conversation_id     TEXT NOT NULL REFERENCES orchestrator_conversations(id) ON DELETE CASCADE,
      task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      phase               TEXT NOT NULL DEFAULT 'planning',
      artifacts           TEXT,
      depends_on          TEXT,
      attempts            INTEGER NOT NULL DEFAULT 0,
      last_event_seq      INTEGER NOT NULL DEFAULT 0,
      artifact_lock_owner TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_task_id
      ON managed_tasks(task_id);

    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_task_id
      ON events(task_id, seq);

    -- Idempotency cache for orchestrator write actions (SHR-163). Keyed by a
    -- content hash of (action + input); a retried RPC within the TTL window
    -- returns the original result instead of re-executing (no double-create).
    CREATE TABLE IF NOT EXISTS orchestrator_action_results (
      idempotency_key TEXT PRIMARY KEY,
      action          TEXT NOT NULL,
      result          TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Global-monitor mode column (2026-06-20, SHR-136) ────────────────────────
  // Exactly one conversation may be designated as global-monitor (receives
  // read-only notices for unowned tasks). Forward-only, addColumn-guarded.
  const orchConvCols = columnsOf(instance, 'orchestrator_conversations');
  addColumn(
    instance,
    'orchestrator_conversations',
    'is_global_monitor',
    'is_global_monitor INTEGER NOT NULL DEFAULT 0',
    orchConvCols,
  );
  // ── Conductor hook token (orchestrator gate auth) ───────────────────────────
  // The conductor session is not an `agents` row, so its PreToolUse gate hook
  // token has nowhere to live in the agents table. Persist it here so
  // requireHookToken can authenticate the conductor's gate callbacks. Forward-only.
  addColumn(instance, 'orchestrator_conversations', 'hook_token', 'hook_token TEXT', orchConvCols);
  // ── Conductor cwd (for resume) ──────────────────────────────────────────────
  // The working dir the conductor session was launched from. Needed to RESUME a
  // conversation whose tmux/claude session died (server restart, crash, stop) —
  // resumeConversation relaunches `claude --resume <id>` from this cwd. Forward-only.
  addColumn(instance, 'orchestrator_conversations', 'cwd', 'cwd TEXT', orchConvCols);
  // Ensure at most one row has is_global_monitor=1 (partial unique index — SQLite
  // WHERE clause filters NULLs but since we use 0/1 we need a different approach;
  // enforce uniqueness in application logic via setGlobalMonitor clearing old value).

  // ── Loop harness persistence (2026-07-12, P1a) ──────────────────────────────
  instance.exec(`
    CREATE TABLE IF NOT EXISTS loop_runs (
      id                  TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      spec_json           TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'running',
      iteration           INTEGER NOT NULL DEFAULT 0,
      max_iterations      INTEGER,
      budget_json         TEXT,
      termination_reason  TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loop_runs_task ON loop_runs(task_id);

    CREATE TABLE IF NOT EXISTS loop_iterations (
      id             TEXT PRIMARY KEY,
      loop_run_id    TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
      n              INTEGER NOT NULL,
      sha_from       TEXT,
      sha_to         TEXT,
      verify_passed  INTEGER,
      tokens         INTEGER,
      emit_status    TEXT,
      emit_reason    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loop_iterations_run ON loop_iterations(loop_run_id, n);
  `);

  // ── PR-extract workflow persistence (2026-07-13, P3) ────────────────────────
  instance.exec(`
    CREATE TABLE IF NOT EXISTS pr_extracts (
      id             TEXT PRIMARY KEY,
      task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      repo_path      TEXT NOT NULL,
      pr_number      INTEGER NOT NULL,
      pr_head_sha    TEXT NOT NULL,
      area           TEXT NOT NULL,
      risk           TEXT NOT NULL,
      has_migration  INTEGER NOT NULL,
      surface        TEXT NOT NULL,
      loc            INTEGER NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_extracts_task ON pr_extracts(task_id);
    CREATE INDEX IF NOT EXISTS idx_pr_extracts_pr ON pr_extracts(repo_path, pr_number);
  `);

  // ── Best-of-N loop groups (2026-07-13, P4) ──────────────────────────────────
  instance.exec(`
    CREATE TABLE IF NOT EXISTS loop_groups (
      id                  TEXT PRIMARY KEY,
      spec_json           TEXT NOT NULL,
      n                   INTEGER NOT NULL,
      repo_path           TEXT NOT NULL,
      base_branch         TEXT NOT NULL,
      judge_status        TEXT NOT NULL DEFAULT 'not_run',
      winner_loop_run_id  TEXT REFERENCES loop_runs(id),
      judge_rationale     TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const loopRunsColsForGroup = columnsOf(instance, 'loop_runs');
  addColumn(
    instance,
    'loop_runs',
    'group_id',
    'group_id TEXT REFERENCES loop_groups(id)',
    loopRunsColsForGroup,
  );
  instance.exec(`CREATE INDEX IF NOT EXISTS idx_loop_runs_group ON loop_runs(group_id);`);
}
