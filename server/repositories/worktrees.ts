/**
 * Repository layer for the `worktrees` table.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { Worktree, RunMode, WorktreeStatus, WorktreeSummary } from '../types.js';

const logger = childLogger('repositories/worktrees');

// ─── Worktree reads ───────────────────────────────────────────────────────────

/** Fetch a single worktree by id. */
export function getWorktree(id: string): Worktree | undefined {
  return getDb().prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Worktree | undefined;
}

/** List all distinct repo_paths tracked by worktrees. */
export function listTrackedRepoPaths(): Array<{ repo_path: string }> {
  return getDb()
    .prepare(`SELECT DISTINCT repo_path FROM worktrees WHERE repo_path IS NOT NULL`)
    .all() as Array<{ repo_path: string }>;
}

/**
 * List worktrees aggregated into workspace groups (for GET /api/worktrees).
 * Collapses duplicate physical workspaces (same repo_path/mode/branch/path),
 * returns the freshest row of each group plus task_count and active_task_id.
 */
export function listWorktrees(): WorktreeSummary[] {
  return getDb()
    .prepare(
      `WITH grouped AS (
           SELECT w.id,
                  w.path,
                  w.repo_path,
                  w.branch,
                  w.base_branch,
                  w.base_sha,
                  w.mode,
                  w.status,
                  w.created_at,
                  w.last_used_at,
                  COALESCE(w.repo_path, '') || '|' ||
                  COALESCE(w.mode, '')      || '|' ||
                  COALESCE(w.branch, '')    || '|' ||
                  COALESCE(w.path, '')      AS group_key,
                  COALESCE(w.last_used_at, w.created_at) AS recency,
                  ROW_NUMBER() OVER (
                    PARTITION BY
                      COALESCE(w.repo_path, ''),
                      COALESCE(w.mode, ''),
                      COALESCE(w.branch, ''),
                      COALESCE(w.path, '')
                    ORDER BY COALESCE(w.last_used_at, w.created_at) DESC, w.id DESC
                  ) AS rn
             FROM worktrees w
            WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.worktree_id = w.id AND t.deleted_at IS NULL)
         ),
         agg AS (
           SELECT group_key,
                  COUNT(*) FILTER (WHERE 1=1) AS row_count,
                  SUM(
                    (SELECT COUNT(*) FROM tasks t WHERE t.worktree_id = grouped.id AND t.deleted_at IS NULL)
                  ) AS task_count,
                  MAX(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END) AS any_in_use,
                  MAX(recency) AS recency
             FROM grouped
            GROUP BY group_key
         )
         SELECT g.id,
                g.path,
                g.repo_path,
                g.branch,
                g.base_branch,
                g.base_sha,
                g.mode,
                CASE WHEN agg.any_in_use = 1 THEN 'in_use' ELSE 'available' END AS status,
                g.created_at,
                agg.recency AS last_used_at,
                agg.task_count AS task_count,
                (SELECT t.id FROM tasks t
                   INNER JOIN worktrees w2 ON w2.id = t.worktree_id
                  WHERE COALESCE(w2.repo_path,'') || '|' || COALESCE(w2.mode,'') || '|'
                     || COALESCE(w2.branch,'')   || '|' || COALESCE(w2.path,'')
                      = g.group_key
                    AND t.runtime_state IN ('idle','setting_up','running')
                    AND t.deleted_at IS NULL
                  ORDER BY CASE t.runtime_state
                             WHEN 'running'    THEN 0
                             WHEN 'setting_up' THEN 1
                             ELSE 2
                           END, t.updated_at DESC
                  LIMIT 1) AS active_task_id
           FROM grouped g
           INNER JOIN agg ON agg.group_key = g.group_key
          WHERE g.rn = 1
          ORDER BY agg.recency DESC`,
    )
    .all() as WorktreeSummary[];
}

/**
 * List tasks that reference a worktree (minimal fields for conflict checking).
 * Used before deleting a worktree to verify no active tasks reference it.
 */
export function listTasksForWorktree(
  worktreeId: string,
): Array<{ id: string; runtime_state: string }> {
  return getDb()
    .prepare('SELECT id, runtime_state FROM tasks WHERE worktree_id = ?')
    .all(worktreeId) as Array<{ id: string; runtime_state: string }>;
}

// ─── Worktree writes ──────────────────────────────────────────────────────────

export interface InsertWorktreeInput {
  id?: string;
  path: string;
  repo_path?: string | null;
  branch?: string | null;
  base_branch?: string | null;
  base_sha?: string | null;
  mode: RunMode;
  status?: WorktreeStatus;
}

/** Insert a new worktree row. Returns the generated id. */
export function insertWorktree(input: InsertWorktreeInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO worktrees
         (id, path, repo_path, branch, base_branch, base_sha, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.path,
      input.repo_path ?? null,
      input.branch ?? null,
      input.base_branch ?? null,
      input.base_sha ?? null,
      input.mode,
      input.status ?? 'available',
    );
  logger.info(
    { worktree_id: id, mode: input.mode, operation: 'insertWorktree' },
    'worktree inserted',
  );
  return id;
}

/**
 * Insert a worktree with last_used_at = datetime('now') (used on task start).
 * Returns the generated id.
 */
export function insertWorktreeInUse(input: InsertWorktreeInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO worktrees
         (id, path, repo_path, branch, base_branch, base_sha, mode, status, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_use', datetime('now'))`,
    )
    .run(
      id,
      input.path,
      input.repo_path ?? null,
      input.branch ?? null,
      input.base_branch ?? null,
      input.base_sha ?? null,
      input.mode,
    );
  logger.info(
    { worktree_id: id, mode: input.mode, operation: 'insertWorktreeInUse' },
    'worktree inserted as in_use',
  );
  return id;
}

/**
 * Mark a worktree as available and update last_used_at (called on task close/delete).
 */
export function releaseWorktree(id: string): void {
  getDb()
    .prepare(
      `UPDATE worktrees SET status = 'available', last_used_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
  logger.info({ worktree_id: id, operation: 'releaseWorktree' }, 'worktree released');
}

export interface UpdateWorktreeInput {
  path?: string;
  repo_path?: string | null;
  branch?: string | null;
  base_branch?: string | null;
  base_sha?: string | null;
  mode?: RunMode;
  status?: WorktreeStatus;
}

// Allowed columns for dynamic SET (injection-safe allowlist)
const WORKTREE_WRITABLE_COLUMNS = new Set([
  'path',
  'repo_path',
  'branch',
  'base_branch',
  'base_sha',
  'mode',
  'status',
  'last_used_at',
]);

/**
 * Dynamically update a whitelist of worktree fields.
 * Optionally sets last_used_at = datetime('now') when touchUsed is true.
 */
export function updateWorktreeFields(
  id: string,
  patch: Partial<Record<string, unknown>>,
  touchUsed = false,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!WORKTREE_WRITABLE_COLUMNS.has(key)) {
      throw new Error(`updateWorktreeFields: column '${key}' is not in the writable allowlist`);
    }
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (touchUsed) {
    fields.push(`last_used_at = datetime('now')`);
  }

  if (fields.length === 0) return;

  values.push(id);
  getDb()
    .prepare(`UPDATE worktrees SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

/**
 * Full update for a worktree row on task setup: path, repo_path, branch,
 * base_branch, base_sha, mode, status='in_use', last_used_at=now.
 */
export function updateWorktreeOnSetup(
  id: string,
  patch: {
    path: string;
    repo_path: string | null;
    branch: string | null;
    base_branch: string | null;
    base_sha: string | null;
    mode: RunMode;
  },
): void {
  getDb()
    .prepare(
      `UPDATE worktrees
          SET path = ?, repo_path = ?, branch = ?, base_branch = ?, base_sha = ?,
              mode = ?, status = 'in_use', last_used_at = datetime('now')
        WHERE id = ?`,
    )
    .run(
      patch.path,
      patch.repo_path,
      patch.branch,
      patch.base_branch,
      patch.base_sha,
      patch.mode,
      id,
    );
  logger.info(
    { worktree_id: id, operation: 'updateWorktreeOnSetup' },
    'worktree updated on task setup',
  );
}

/**
 * Update base_branch + base_sha only (called from the PATCH /api/tasks/:id/base endpoint).
 */
export function setWorktreeBase(id: string, baseBranch: string, baseSha: string): void {
  getDb()
    .prepare(`UPDATE worktrees SET base_branch = ?, base_sha = ? WHERE id = ?`)
    .run(baseBranch, baseSha, id);
  logger.info(
    { worktree_id: id, base_branch: baseBranch, operation: 'setWorktreeBase' },
    'worktree base updated',
  );
}

/** Hard-delete a worktree row. */
export function deleteWorktree(id: string): void {
  getDb().prepare('DELETE FROM worktrees WHERE id = ?').run(id);
  logger.info({ worktree_id: id, operation: 'deleteWorktree' }, 'worktree deleted');
}

/**
 * Insert a worktree row only when no row with the same id already exists
 * (INSERT OR IGNORE). Used by the test seed endpoint to make seeding idempotent.
 */
export function insertWorktreeIfAbsent(input: {
  id: string;
  path: string;
  repo_path?: string | null;
  branch?: string | null;
  base_branch?: string | null;
  mode: RunMode;
  status?: WorktreeStatus;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO worktrees
         (id, path, repo_path, branch, base_branch, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.path,
      input.repo_path ?? null,
      input.branch ?? null,
      input.base_branch ?? null,
      input.mode,
      input.status ?? 'available',
    );
}
