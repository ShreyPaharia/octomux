import fs from 'fs';
import path from 'path';
import type Database from '../sqlite.js';
import { nanoid } from 'nanoid';
import { childLogger } from '../logger.js';
import { builtInKindsDir } from '../octomux-paths.js';
import { applyJsonSchemaDefaults } from '../workflows/config.js';
import { hasArtifactSummary, setArtifactSummary } from '../artifact.js';
import type { JsonSchema } from '../services/output-contract.js';

const logger = childLogger('db');

/**
 * Read a built-in kind preset's JSON straight off disk — used only by the
 * schedule-kinds-as-presets migration below. Deliberately does NOT go through
 * `workflows/presets.ts` (which transitively imports the workflow registry,
 * which transitively imports `repositories/*` → `db.ts`): importing that here
 * would create `db.ts` → `migrations.ts` → `workflows/index.ts` → `db.ts`, a
 * circular import through code that calls `getDb()` at module scope. This
 * migration only needs the shipped preset's raw `prompt`/`config` fields, so a
 * plain `fs.readFileSync` + `JSON.parse` sidesteps the cycle entirely.
 */
function readBuiltInPreset(kind: string): { prompt?: string; config?: JsonSchema } | undefined {
  try {
    const raw = fs.readFileSync(path.join(builtInKindsDir(), `${kind}.json`), 'utf-8');
    const data = JSON.parse(raw) as { prompt?: unknown; config?: unknown };
    return {
      prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
      config: (data.config as JsonSchema | undefined) ?? undefined,
    };
  } catch {
    return undefined;
  }
}

export function columnsOf(instance: Database, table: string): Set<string> {
  const rows = instance.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((c) => c.name));
}

/** True when `table` exists. The collapse migration (2026-08-22) needs this: a
 *  fresh database never ran the pre-collapse CREATE blocks, so an unguarded
 *  `INSERT ... SELECT FROM plugin_facts` would throw `no such table`. */
export function tableExists(instance: Database, table: string): boolean {
  return (
    (
      instance
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .all(table) as unknown[]
    ).length > 0
  );
}

export function addColumn(
  instance: Database,
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

function agentFkIsNotNull(instance: Database): boolean {
  const rows = instance.pragma('table_info(workers)') as Array<{
    name: string;
    notnull: number;
  }>;
  const col = rows.find((c) => c.name === 'task_id');
  return !!col && col.notnull === 1;
}

/**
 * Rebuild the `workers` table to make `task_id` nullable while preserving rows,
 * FK, cascade behaviour, and indexes. SQLite < 3.35 can't ALTER a column's
 * NOT NULL in place; a table rebuild is the supported path.
 */
function rebuildAgentsTable(instance: Database): void {
  instance.transaction(() => {
    // Capture dynamically-added columns that may not exist in the CREATE.
    const oldCols = (instance.pragma('table_info(workers)') as Array<{ name: string }>).map(
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

    instance.exec(`INSERT INTO agents_new SELECT ${selectCols} FROM workers`);
    instance.exec(`DROP TABLE workers`);
    instance.exec(`ALTER TABLE agents_new RENAME TO workers`);

    // Recreate indexes (idempotent CREATE IF NOT EXISTS).
    instance.exec(`CREATE INDEX IF NOT EXISTS idx_workers_task ON workers(task_id)`);
    instance.exec(
      `CREATE INDEX IF NOT EXISTS idx_workers_harness_session_id ON workers(harness_session_id)`,
    );
  })();
}

/**
 * One-time copy of the retired `tasks.current_summary` column into each task's
 * `.octomux/artifact.md`, so existing summaries survive the move to file-backed
 * storage instead of silently blanking every board card on upgrade.
 *
 * Idempotent and non-destructive by construction:
 *  - skips any task whose artifact already has a Summary section, so a
 *    post-migration edit is never clobbered by a later restart;
 *  - preserves the original `current_summary_updated_at` rather than restamping
 *    to now, which would make stale summaries look fresh;
 *  - leaves the columns in place (see the call site for why);
 *  - never throws. A missing or unwritable worktree is expected — a done or
 *    trashed task has none — and must not take down server startup. Failures
 *    are counted and logged, not raised.
 */
function backfillSummariesIntoArtifacts(instance: Database, taskCols: Set<string>): void {
  if (!taskCols.has('current_summary')) return;
  const hasTs = taskCols.has('current_summary_updated_at');

  let migrated = 0;
  let skippedNoWorktree = 0;
  let failed = 0;
  try {
    const rows = instance
      .prepare(
        // The worktree PATH lives on the joined `worktrees` row; `tasks` only
        // carries the FK. LEFT JOIN so a task whose worktree is gone still
        // comes back (counted as skipped) rather than vanishing from the scan.
        `SELECT t.id AS id, w.path AS worktree, t.current_summary AS summary
              ${hasTs ? ', t.current_summary_updated_at AS updated_at' : ''}
           FROM tasks t
           LEFT JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.current_summary IS NOT NULL AND TRIM(t.current_summary) <> ''`,
      )
      .all() as { id: string; worktree: string | null; summary: string; updated_at?: string }[];

    for (const row of rows) {
      if (!row.worktree) {
        skippedNoWorktree += 1;
        continue;
      }
      try {
        if (hasArtifactSummary(row.worktree)) continue;
        setArtifactSummary(row.worktree, row.summary, row.updated_at ?? undefined);
        migrated += 1;
      } catch (err) {
        failed += 1;
        logger.warn(
          { operation: 'backfillSummariesIntoArtifacts', task_id: row.id, err },
          'could not write artifact for task — its summary stays in the (retired) column',
        );
      }
    }
  } catch (err) {
    logger.warn({ operation: 'backfillSummariesIntoArtifacts', err }, 'summary back-fill skipped');
    return;
  }

  if (migrated || skippedNoWorktree || failed) {
    logger.info(
      { operation: 'backfillSummariesIntoArtifacts', migrated, skippedNoWorktree, failed },
      'copied retired task summaries into .octomux/artifact.md',
    );
  }
}

/** Run forward-only additive migrations on an initialized database. */
export function runMigrations(instance: Database): void {
  // Additive migrations — idempotent, one read per table.
  // Columns added here are ones still present on the current schema; legacy
  // columns (worktree, run_mode, repo_path, branch, base_branch, base_sha)
  // were dropped after Phase 2a and are re-homed in the worktrees table.
  const taskCols = columnsOf(instance, 'tasks');

  const agentCols = columnsOf(instance, 'workers');

  // Rename workers.claude_session_id -> workers.harness_session_id (step-1 of
  // the harness abstraction). Must run BEFORE addColumn for harness_session_id
  // so the rename fires on old DBs before we try to add the new-named column.
  // Idempotent: only runs when the old column still exists.
  // SQLite 3.25+ supports RENAME COLUMN.
  if (agentCols.has('claude_session_id') && !agentCols.has('harness_session_id')) {
    instance.exec(`ALTER TABLE workers RENAME COLUMN claude_session_id TO harness_session_id`);
    instance.exec(`DROP INDEX IF EXISTS idx_agents_claude_session_id`);
    agentCols.delete('claude_session_id');
    agentCols.add('harness_session_id');
  }

  addColumn(instance, 'workers', 'harness_session_id', 'harness_session_id TEXT', agentCols);
  addColumn(
    instance,
    'workers',
    'hook_activity',
    "hook_activity TEXT NOT NULL DEFAULT 'active'",
    agentCols,
  );
  addColumn(
    instance,
    'workers',
    'hook_activity_updated_at',
    'hook_activity_updated_at TEXT',
    agentCols,
  );
  addColumn(
    instance,
    'workers',
    'harness_id',
    `harness_id TEXT NOT NULL DEFAULT 'claude-code'`,
    agentCols,
  );
  addColumn(instance, 'workers', 'hook_token', `hook_token TEXT NOT NULL DEFAULT ''`, agentCols);

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
    `CREATE INDEX IF NOT EXISTS idx_workers_harness_session_id ON workers(harness_session_id)`,
  );

  // ─── Legacy pre-Phase-2a shim: add run_mode / backfill from no_worktree ──
  // Needed only for very old DBs that predate run_mode. The Phase 2a backfill
  // below expects tasks.run_mode to exist.
  if (taskCols.has('no_worktree') && !taskCols.has('run_mode')) {
    instance.transaction(() => {
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
    })();
  } else if (taskCols.has('no_worktree')) {
    // run_mode already exists; backfill it from no_worktree for any NULL rows,
    // then drop the dead column.
    instance.transaction(() => {
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
    })();
  }

  // ─── Phase 2a migration: worktrees entity + workers.task_id nullable ──────
  // Additive shape: introduces `worktrees` table, `tasks.worktree_id`,
  // `workers.pinned`, `workers.tmux_session`, and nullable `workers.task_id`.
  // Legacy columns on `tasks` (worktree, run_mode, etc.) remain for now;
  // a later phase rewrites consumers then drops them.
  const agentFk = agentFkIsNotNull(instance);
  // Only run the backfill if the legacy `worktree` column still exists on
  // tasks — on fresh DBs it's already gone and there's nothing to backfill.
  const canBackfill = taskCols.has('worktree');
  {
    instance.transaction(() => {
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
        insertWt.run(wtId, r.worktree!, repoPath, branch, baseBranch, baseSha, mode, r.created_at);
        linkTask.run(wtId, r.id);
      }
    })();
  }

  // Make workers.task_id nullable via table rebuild if currently NOT NULL.
  if (agentFk) {
    rebuildAgentsTable(instance);
  }

  // Add workers.tmux_session column (post-rebuild).
  const agentCols2 = columnsOf(instance, 'workers');
  addColumn(instance, 'workers', 'tmux_session', 'tmux_session TEXT', agentCols2);
  addColumn(instance, 'workers', 'agent', 'agent TEXT', agentCols2);
  // Drop legacy `pinned` column from older installs (carried the singleton
  // orchestrator row). SQLite >= 3.35 supports DROP COLUMN.
  if (agentCols2.has('pinned')) {
    instance.exec(`ALTER TABLE workers DROP COLUMN pinned`);
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
  addColumn(instance, 'tasks', 'compute', 'compute TEXT', taskColsForAgent);

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
    instance.transaction(() => {
      instance.exec(`DROP INDEX IF EXISTS idx_tasks_existing_path`);
      instance.exec(`DROP INDEX IF EXISTS idx_tasks_none_repo`);
      for (const col of legacyCols) {
        if (currentTaskCols.has(col)) {
          instance.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
        }
      }
    })();
  }

  // Drop old partial unique index first (it referenced status; we'll recreate
  // it after runtime_state column is guaranteed to exist).
  instance.exec(`DROP INDEX IF EXISTS idx_tasks_active_worktree`);

  // Drop the legacy seeded orchestrator agent row from older installs.
  instance.prepare(`DELETE FROM workers WHERE id = 'orchestrator' AND task_id IS NULL`).run();

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
  // current_summary / current_summary_updated_at are RETIRED (spec §5.5): the
  // narrative now lives in each task's `.octomux/artifact.md` (server/artifact.ts).
  // Nothing reads or writes these columns any more.
  //
  // They are deliberately NOT dropped, and the data is copied out first:
  //
  //  - Back-fill, not just drop. The artifact lives in the task's WORKTREE, so
  //    an upgrade that only dropped the columns would blank the summary on
  //    every existing board card — a visible regression, not just dead storage.
  //  - Keep the columns. A task whose worktree is gone (done, trashed, or
  //    created with no_worktree) has nowhere to put its artifact, so its
  //    summary cannot be migrated at all. Dropping would destroy that text
  //    irreversibly for zero functional gain, since no code reads it either
  //    way. Dormant columns are cheap; unrecoverable user prose is not. Drop
  //    them in a later release once back-fill is confirmed across installs.
  backfillSummariesIntoArtifacts(instance, taskColsV2);
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
        agent_id    TEXT REFERENCES workers(id) ON DELETE SET NULL,
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
    instance.transaction(() => {
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
    })();
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
    instance.transaction(() => {
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
            FOREIGN KEY (agent_id) REFERENCES workers(id) ON DELETE CASCADE
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
    })();
  }

  // Resolve stale pending prompts and reset workers stuck in 'waiting'
  // (hook callbacks lost during the previous run's shutdown)
  instance.exec(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`,
  );
  instance.exec(
    `UPDATE workers SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
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

  // ── Intra-task sub-workers: notify_agent_id on workers (2026-06-11) ──────────
  // When a sub-agent completes, its parent agent is notified via this link.
  const agentCols3 = columnsOf(instance, 'workers');
  addColumn(instance, 'workers', 'notify_agent_id', 'notify_agent_id TEXT', agentCols3);

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
      depends_on          TEXT, -- retired: dead DAG-scheduler column, unread since server/orchestrator/mcp/verify.ts was deleted; never written by production code either
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
  // The conductor session is not a `workers` row, so its PreToolUse gate hook
  // token has nowhere to live in the workers table. Persist it here so
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

  // ── Multiple PRs per task — pull_requests table (2026-07-31) ────────────────
  // Forward-only. CREATE TABLE IF NOT EXISTS is idempotent for fresh DBs (already
  // in SCHEMA). For old DBs that ran an earlier SCHEMA without this table, the
  // CREATE ensures the table exists before we backfill from tasks.pr_url.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      branch      TEXT NOT NULL,
      base_branch TEXT,
      number      INTEGER,
      url         TEXT,
      head_sha    TEXT,
      title       TEXT,
      state       TEXT NOT NULL DEFAULT 'open',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_pull_requests_task_id ON pull_requests(task_id);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_state ON pull_requests(state);
  `);

  // Backfill: for every task that has a non-null pr_url, insert one pull_requests
  // row using the task's branch (from the joined worktrees table). Idempotent via
  // INSERT OR IGNORE (guarded by the UNIQUE(task_id, branch) constraint).
  instance.exec(`
    INSERT OR IGNORE INTO pull_requests (id, task_id, branch, base_branch, number, url, state)
    SELECT
      lower(hex(randomblob(6))) || lower(hex(randomblob(6))),
      t.id,
      w.branch,
      w.base_branch,
      t.pr_number,
      t.pr_url,
      'open'
    FROM tasks t
    INNER JOIN worktrees w ON t.worktree_id = w.id
    WHERE t.pr_url IS NOT NULL
      AND w.branch IS NOT NULL
  `);

  // ── Remove the Teams feature (2026-07-18, P0) ────────────────────────────
  // Forward-only drop: team_schedules/team_runs are no longer read or written.
  instance.exec('DROP TABLE IF EXISTS team_runs;');
  instance.exec('DROP TABLE IF EXISTS team_schedules;');

  // ── Per-schedule config overrides (2026-07-18, P4) ───────────────────────
  const scheduleCols = columnsOf(instance, 'schedules');
  addColumn(instance, 'schedules', 'config_json', 'config_json TEXT', scheduleCols);
  addColumn(instance, 'schedules', 'prompt', 'prompt TEXT', scheduleCols);

  // ── Schedule configurability: name/timezone/model/timeout_ms + drop UNIQUE
  // (2026-07-24) ─────────────────────────────────────────────────────────────
  // Table rebuild: adds new columns, removes UNIQUE(kind, repo_path) constraint.
  // Idempotency guard: only run when `timezone` column is missing.
  // Transaction-wrapped so a crash mid-rebuild cannot lose the table.
  if (!columnsOf(instance, 'schedules').has('timezone')) {
    instance.transaction(() => {
      instance.exec(`
          CREATE TABLE schedules_new (
            id            TEXT PRIMARY KEY,
            kind          TEXT NOT NULL,
            repo_path     TEXT NOT NULL,
            name          TEXT,
            cron          TEXT NOT NULL,
            timezone      TEXT,
            enabled       INTEGER NOT NULL DEFAULT 1,
            model         TEXT,
            timeout_ms    INTEGER,
            last_run_at   TEXT,
            config_json   TEXT,
            prompt        TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      instance.exec(`
          INSERT INTO schedules_new
            (id, kind, repo_path, cron, enabled, last_run_at, config_json, prompt, created_at, updated_at)
          SELECT
            id, kind, repo_path, cron, enabled, last_run_at, config_json, prompt, created_at, updated_at
          FROM schedules
        `);
      instance.exec(`DROP TABLE schedules`);
      instance.exec(`ALTER TABLE schedules_new RENAME TO schedules`);
    })();
  }

  // ── Link scheduled runs back to their schedule (2026-07-18, P5) ──────────
  const taskColsForSchedule = columnsOf(instance, 'tasks');
  addColumn(instance, 'tasks', 'schedule_id', 'schedule_id TEXT', taskColsForSchedule);

  // ── Agent learnings store (2026-07-23, §12 P2) ───────────────────────────
  instance.exec(`
    CREATE TABLE IF NOT EXISTS agent_learnings (
      id            TEXT PRIMARY KEY,
      repo_path     TEXT NOT NULL,
      lane          TEXT NOT NULL,          -- 'shared' | 'loop:<task-id>' | 'schedule:<id>'
      trigger       TEXT NOT NULL,
      lesson        TEXT NOT NULL,
      evidence      TEXT,
      source_run_id TEXT,
      source_commit TEXT,
      usage_count   INTEGER NOT NULL DEFAULT 0,
      last_used_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_learnings_read ON agent_learnings(repo_path, lane);
  `);
  const loopIterCols = columnsOf(instance, 'loop_iterations');
  addColumn(
    instance,
    'loop_iterations',
    'learnings_seeded',
    'learnings_seeded INTEGER',
    loopIterCols,
  );

  // ── Fold review_learnings into agent_learnings (2026-07-23, review lane) ─
  // PR-review learnings now live in agent_learnings (lane='review'). Forward-only drop.
  instance.exec('DROP TABLE IF EXISTS review_learnings;');

  // ── Soft-supersede for agent_learnings (2026-07-23, §12 P2 Task 10) ──────
  const agentLearningsCols = columnsOf(instance, 'agent_learnings');
  addColumn(instance, 'agent_learnings', 'superseded_at', 'superseded_at TEXT', agentLearningsCols);
  addColumn(
    instance,
    'agent_learnings',
    'superseded_reason',
    'superseded_reason TEXT',
    agentLearningsCols,
  );

  // ── Gateway: channel↔conversation map + inbound dedup (2026-07-23) ────────
  instance.exec(`
    CREATE TABLE IF NOT EXISTS channel_threads (
      channel     TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      conv_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, thread_key)
    );
    CREATE TABLE IF NOT EXISTS gateway_inbound (
      channel      TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, external_id)
    );
  `);

  // ── Agents feature: long-running agent config + owning conversation link
  // (2026-07-24) ─────────────────────────────────────────────────────────────
  // Table named `agents` — the persistent conductor agent. Not to be confused
  // with `workers` (a per-task tmux-window worker, renamed from `agents` in
  // the 2026-07-25 agents/workers terminology cleanup below). An agent's live
  // session is an `orchestrator_conversations` row tagged with agent_id.
  //
  // CREATE TABLE IF NOT EXISTS here is safe even on an old, not-yet-renamed
  // install: at this point `agents` still means the old worker table, so this
  // statement no-ops (table already exists under that name) and the real
  // conductor table gets created once the rename below vacates the name.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      system_prompt  TEXT NOT NULL,
      channel        TEXT,
      channel_config TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const orchConvColsForAgent = columnsOf(instance, 'orchestrator_conversations');
  addColumn(
    instance,
    'orchestrator_conversations',
    'agent_id',
    'agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL',
    orchConvColsForAgent,
  );

  // ── Schedule kinds as presets (2026-07-25, spec/schedule-kinds-as-presets.md
  // §8) ─────────────────────────────────────────────────────────────────────
  // Forward-only, transaction-wrapped, guarded on `schedule_skills` still
  // existing — a no-op on fresh installs (SCHEMA no longer creates the table)
  // and on every boot after the first successful run.
  const tablesForKindsPreset = new Set(
    (
      instance.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  if (tablesForKindsPreset.has('schedule_skills')) {
    instance.transaction(() => {
      // 1. Backfill schedules.prompt for rows where prompt is NULL/empty,
      // joined on kind against schedule_skills; fall back to the shipped
      // preset's prompt when no schedule_skills row exists for that kind
      // (production: 1 such row, doc-drift).
      const rowsToBackfill = instance
        .prepare(`SELECT id, kind FROM schedules WHERE prompt IS NULL OR prompt = ''`)
        .all() as Array<{ id: string; kind: string }>;
      const getSkillRow = instance.prepare(`SELECT content FROM schedule_skills WHERE kind = ?`);
      const updatePrompt = instance.prepare(`UPDATE schedules SET prompt = ? WHERE id = ?`);

      for (const row of rowsToBackfill) {
        const skill = getSkillRow.get(row.kind) as { content: string } | undefined;
        const prompt = skill?.content ?? readBuiltInPreset(row.kind)?.prompt;
        if (prompt) updatePrompt.run(prompt, row.id);
      }

      // 2. Materialize config_json defaults for every existing row against
      // its kind's current shipped config schema.
      const allScheduleRows = instance
        .prepare(`SELECT id, kind, config_json FROM schedules`)
        .all() as Array<{ id: string; kind: string; config_json: string | null }>;
      const updateConfig = instance.prepare(`UPDATE schedules SET config_json = ? WHERE id = ?`);

      // Always write, even for kinds with no config schema (weekly-update,
      // daily-plan): post-migration `config_json` is never NULL, so the
      // read path's `?? '{}'` is belt-and-braces rather than load-bearing.
      for (const row of allScheduleRows) {
        const schema = readBuiltInPreset(row.kind)?.config;
        const existing = row.config_json ? JSON.parse(row.config_json) : {};
        const materialized = schema ? applyJsonSchemaDefaults(schema, existing) : existing;
        updateConfig.run(JSON.stringify(materialized), row.id);
      }

      // 3. Drop the now-superseded table.
      instance.exec(`DROP TABLE schedule_skills`);
    })();
    logger.info('migrated schedule_skills into schedules.prompt/config_json and dropped the table');
  }

  // ── Loop-group run-adoption link (2026-08-13, surface-cuts) ────────────────
  // Reverse link from a loop_groups row to its `runs` row — mirrors
  // LoopSpec.runId, the analogous reverse link a plain loop_run carries in its
  // own spec_json. Lets GET/POST /api/runs/:id and POST /api/runs/:id/emit
  // resolve a loop-group run without growing `runs` itself (see
  // server/repositories/loop-groups.ts's getLoopGroupByRunId).
  const loopGroupsCols = columnsOf(instance, 'loop_groups');
  addColumn(instance, 'loop_groups', 'run_id', 'run_id TEXT REFERENCES runs(id)', loopGroupsCols);
  instance.exec(`CREATE INDEX IF NOT EXISTS idx_loop_groups_run ON loop_groups(run_id);`);

  // ── Task dependency primitive (2026-08-14, agents/task-depends-on) ─────────
  // Promotes `depends_on` off `managed_tasks` (orchestrator-only) onto plain
  // `tasks`, so any task can depend on any other task, not just ones inside a
  // conductor conversation. One dependency per task (not the JSON array
  // `managed_tasks.depends_on` uses for its DAG scheduler — that table is
  // untouched by this migration and keeps working as-is).
  //
  // ON DELETE SET NULL (mirrors review_of_task_id above) so hard-deleting a
  // dependency unblocks its dependent instead of orphaning the FK.
  // Cycle safety (self-reference, 2-cycles, longer cycles) is NOT expressible
  // as a DDL constraint here — SQLite has no CHECK that can walk a
  // self-referencing chain — so it's enforced at the application layer
  // (repositories/tasks.ts:validateDependsOn) on every write.
  const taskColsForDependsOn = columnsOf(instance, 'tasks');
  addColumn(
    instance,
    'tasks',
    'depends_on',
    'depends_on TEXT REFERENCES tasks(id) ON DELETE SET NULL',
    taskColsForDependsOn,
  );
  instance.exec(
    `CREATE INDEX IF NOT EXISTS idx_tasks_depends_on
       ON tasks(depends_on) WHERE depends_on IS NOT NULL`,
  );

  // ── Re-review trigger tracking (2026-08-19) ────────────────────────────────
  // Latest GitHub REVIEW_REQUESTED_EVENT timestamp seen for the owner on this
  // PR, so the reviewer poller can fire a re-review when review is re-requested
  // without a push (head SHA unchanged).
  const taskColsForReReview = columnsOf(instance, 'tasks');
  addColumn(
    instance,
    'tasks',
    'pr_review_requested_at',
    'pr_review_requested_at TEXT',
    taskColsForReReview,
  );
  // ── ctx.records — one store for plugin data (2026-08-22) ────────────────────
  // Additive only: creates the table the collapse will replace plugin_facts /
  // plugin_collections / plugin_kv with. The copy-from-old-tables and the
  // matching DROPs are NOT here — they land in the collapse's final commit,
  // atomic with deleting the old tables' last consumers. Migrations re-run on
  // every boot with no version table, so a copy against tables that still
  // exist would duplicate every row on every boot; the copy has to happen in
  // the same commit as the drop, not before it. Don't add them here.
  //
  // Still NOT the `events` table: ruling R1 keeps plugin data out of the
  // orchestrator's control bus, and that is unchanged here.
  //
  // The partial unique index scopes uniqueness to KEYED (upsert) rows. Append
  // rows have key IS NULL and are excluded, so two appends in one store never
  // collide.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS plugin_records (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      store      TEXT NOT NULL,
      task_id    TEXT,
      key        TEXT,
      payload    TEXT NOT NULL DEFAULT '{}',
      owner      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_records_key
      ON plugin_records(store, key) WHERE key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_plugin_records_task
      ON plugin_records(task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plugin_records_store
      ON plugin_records(store, seq);
  `);

  // ── ctx.facts — plugin fact log (2026-08-20, SHR-255) ───────────────────────
  // Deliberately its OWN table, not the `events` table — that one is the
  // orchestrator's control bus (repositories/orchestrator.ts, drained via
  // managed_tasks.last_event_seq). Sharing it would put plugin observation
  // facts into the conductor's drain and share one AUTOINCREMENT seq between
  // control events and facts (ruling R1, plans/2026-08-20-plugin-runtime-p0.md).
  // No FK to tasks(id): facts are deleted explicitly by task deletion
  // (server/repositories/tasks.ts hardDeleteTask), not via ON DELETE CASCADE.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS plugin_facts (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_facts_task ON plugin_facts(task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plugin_facts_type ON plugin_facts(type, seq);
  `);

  // ── ctx.collections — durable keyed records (2026-08-21, SHR-275) ─────────
  // The durable sibling of plugin_facts above: a small upsert store keyed on
  // (collection, key) instead of an append-only log keyed on task_id. Its own
  // table for the same reason plugin_facts got its own table rather than
  // reusing `events` — different lifetime, different shape. Rows here are
  // DURABLE: unlike plugin_facts there is deliberately no delete-on-task-delete
  // sweep, because a collection record has no task in the picture at all.
  // No extra index: every query filters on `collection`, which is the leading
  // column of the PRIMARY KEY, so the PK's own b-tree already covers it.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS plugin_collections (
      collection TEXT NOT NULL,
      key        TEXT NOT NULL,
      record     TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (collection, key)
    );
  `);

  // ── ctx.kv — plugin-private durable scratch (2026-08-22, SHR-263) ─────────
  // Not plugin_collections with a nullable schema, and not plugin_facts: this
  // is opaque per-plugin blob storage, never queryable and never validated
  // against a schema, where a collection is schema-validated and unscoped for
  // reads, and a fact is a task-scoped append-only log. Different API
  // (get/put/delete/list by exact key or prefix, no where/orderBy language),
  // different consumer (a plugin's own private scratch, never read by
  // another plugin), same reasoning as ruling R1 that split facts from
  // collections in the first place — don't collapse three shapes into one
  // table just because they're all "plugin storage".
  //
  // `owner` is the crash-recovery hook: a plugin stamps its mount id into
  // `owner` before starting a multi-step operation against a key and clears
  // it (back to NULL) when the operation settles. A row still carrying a
  // DIFFERENT mount's id on the next boot is, by definition, an operation
  // that never finished — `listKvEntriesOwnedByOthers` is how a plugin finds
  // that debris after a crash. No extra index: every lookup and prefix scan
  // filters on `plugin_id`, the leading column of the PRIMARY KEY.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL DEFAULT 'null',
      owner      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plugin_id, key)
    );
  `);

  // ── fan-out: run a step per item (2026-08-21, SHR-276) ──────────────────────
  // Own tables rather than reusing `runs` — `runs` is one row per workflow
  // execution with a single `result_json` blob, but the whole point of fan-out
  // is that one run explodes into N item rows, each with its own status and
  // result. Per-item rows are what make a partially-completed run legible (you
  // can see exactly which items are done/pending/dead) and a redrive possible
  // (reset only the dead ones back to pending, leave completed work alone).
  // `fanout_items` has no surrogate id — `(run_id, item_key)` is the natural
  // key, and it's what makes `upsertFanOutItems` idempotent via INSERT OR
  // IGNORE on a re-run over the same source.
  instance.exec(`
    CREATE TABLE IF NOT EXISTS fanout_runs (
      id         TEXT PRIMARY KEY,
      plugin_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'running',
      total      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fanout_runs_plugin ON fanout_runs(plugin_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS fanout_items (
      run_id      TEXT NOT NULL REFERENCES fanout_runs(id) ON DELETE CASCADE,
      item_key    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      item_json   TEXT NOT NULL DEFAULT 'null',
      result_json TEXT,
      error       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_fanout_items_status ON fanout_items(run_id, status);
  `);
}

/**
 * Rename `agents` → `workers` (per-task tmux worker) and `agent_configs` →
 * `agents` (persistent conductor agent) — the 2026-07-25 terminology cleanup
 * that resolves "agent" meaning three different things across the codebase.
 *
 * MUST run before `instance.exec(SCHEMA)`, not inside `runMigrations`. SCHEMA
 * now declares the final `workers` table via `CREATE TABLE IF NOT EXISTS`; on
 * an old, not-yet-renamed install that still has real data in a table named
 * `agents`, running SCHEMA first would create a brand-new EMPTY `workers`
 * table (since none exists yet under that name), and this function's guard
 * (`workers` must not already exist) would then see `workers` present and
 * skip the real rename — silently stranding all worker data in the orphaned
 * `agents` table. Calling this first means `workers` never exists at SCHEMA
 * time except via a real prior rename, so SCHEMA's `CREATE TABLE IF NOT
 * EXISTS workers` always correctly no-ops post-rename.
 *
 * bun:sqlite here runs SQLite with `legacy_alter_table = 0`, under
 * which `ALTER TABLE x RENAME TO y` rewrites `REFERENCES x(...)` clauses in
 * dependent tables automatically (verified empirically, not just assumed):
 * task_updates.agent_id and permission_prompts.agent_id get repointed to
 * workers(id), and orchestrator_conversations.agent_id gets repointed to
 * agents(id) — no separate FK-repair step needed.
 *
 * Order is mandatory: `agents` must become `workers` BEFORE `agent_configs`
 * becomes `agents`, or step 2 collides with the still-existing `agents`
 * table and errors loudly (proven safe — a reversed order throws instead of
 * silently corrupting anything).
 *
 * Idempotent: guarded on `agents` existing AND `workers` NOT existing — false
 * on fresh installs/test DBs (nothing named `agents` ever existed) and false
 * on every boot after the first successful run (both tables already settled).
 * Step 2 additionally no-ops when `agent_configs` doesn't exist (a DB old
 * enough to predate the Agents feature entirely) — the "Agents feature"
 * migration further down creates a fresh `agents` conductor table once step
 * 1 has vacated the name, so there's nothing lost by skipping it here.
 */
export function renameAgentWorkerTables(instance: Database): void {
  const tableNames = new Set(
    (
      instance.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  if (!tableNames.has('agents') || tableNames.has('workers')) return;

  // Step 2 only applies when there's actually an `agent_configs` table to
  // rename — a DB old enough to predate the Agents feature entirely (has the
  // legacy `agents` worker table but never saw `agent_configs` created) has
  // nothing to rename here; the "Agents feature" migration below creates a
  // fresh `agents` conductor table once step 1 has vacated the name.
  const hasAgentConfigs = tableNames.has('agent_configs');

  instance.transaction(() => {
    instance.exec(`ALTER TABLE agents RENAME TO workers`);
    // Legacy index names carried over from the old `agents` table; drop
    // them so SCHEMA's `idx_workers_*` creation below doesn't leave a
    // redundant duplicate index behind.
    instance.exec(`DROP INDEX IF EXISTS idx_agents_task`);
    instance.exec(`DROP INDEX IF EXISTS idx_agents_harness_session_id`);
    if (hasAgentConfigs) {
      instance.exec(`ALTER TABLE agent_configs RENAME TO agents`);
    }
  })();
  logger.info('renamed agents -> workers and agent_configs -> agents');
}
