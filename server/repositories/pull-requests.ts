/**
 * Repository layer for the `pull_requests` table.
 * Stores one row per (task_id, branch) pair; upserts on conflict.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/pull-requests');

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  task_id: string;
  branch: string;
  base_branch: string | null;
  number: number | null;
  url: string | null;
  head_sha: string | null;
  title: string | null;
  state: PullRequestState;
  created_at: string;
  updated_at: string;
}

export interface UpsertPullRequestInput {
  task_id: string;
  branch: string;
  base_branch?: string | null;
  number?: number | null;
  url?: string | null;
  head_sha?: string | null;
  title?: string | null;
  state?: PullRequestState;
}

/**
 * Insert or update a pull_requests row keyed on (task_id, branch).
 * On conflict, updates all supplied fields and bumps updated_at.
 */
export function upsertPullRequest(input: UpsertPullRequestInput): PullRequest {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM pull_requests WHERE task_id = ? AND branch = ?`)
    .get(input.task_id, input.branch) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE pull_requests
          SET base_branch = COALESCE(?, base_branch),
              number      = COALESCE(?, number),
              url         = COALESCE(?, url),
              head_sha    = COALESCE(?, head_sha),
              title       = COALESCE(?, title),
              state       = ?,
              updated_at  = datetime('now')
        WHERE task_id = ? AND branch = ?`,
    ).run(
      input.base_branch ?? null,
      input.number ?? null,
      input.url ?? null,
      input.head_sha ?? null,
      input.title ?? null,
      input.state ?? 'open',
      input.task_id,
      input.branch,
    );
    logger.info(
      { task_id: input.task_id, branch: input.branch, operation: 'upsertPullRequest' },
      'pull_request updated',
    );
  } else {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO pull_requests (id, task_id, branch, base_branch, number, url, head_sha, title, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.branch,
      input.base_branch ?? null,
      input.number ?? null,
      input.url ?? null,
      input.head_sha ?? null,
      input.title ?? null,
      input.state ?? 'open',
    );
    logger.info(
      { task_id: input.task_id, branch: input.branch, pr_id: id, operation: 'upsertPullRequest' },
      'pull_request inserted',
    );
  }

  return getDb()
    .prepare(`SELECT * FROM pull_requests WHERE task_id = ? AND branch = ?`)
    .get(input.task_id, input.branch) as PullRequest;
}

/** List all pull_requests for a task, newest first (rowid breaks ties within the same second). */
export function listPullRequestsByTask(taskId: string): PullRequest[] {
  return getDb()
    .prepare(`SELECT * FROM pull_requests WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(taskId) as PullRequest[];
}

/**
 * Recompute tasks.pr_url / pr_number / pr_head_sha from the task's pull_requests rows.
 * Rule: prefer the most-recently-created `open` PR; fall back to the newest row overall;
 * set all three to NULL if there are no rows.
 * Keeps every existing reader of tasks.pr_* working without changes.
 */
export function syncDerivedPrimaryPr(taskId: string): void {
  const db = getDb();

  // Prefer open, newest first (rowid breaks same-second ties); fall back to any state.
  const primary = db
    .prepare(
      `SELECT url, number, head_sha
         FROM pull_requests
        WHERE task_id = ?
        ORDER BY
          CASE WHEN state = 'open' THEN 0 ELSE 1 END,
          created_at DESC,
          rowid DESC
        LIMIT 1`,
    )
    .get(taskId) as
    | { url: string | null; number: number | null; head_sha: string | null }
    | undefined;

  if (primary) {
    db.prepare(
      `UPDATE tasks
          SET pr_url      = ?,
              pr_number   = ?,
              pr_head_sha = ?,
              updated_at  = datetime('now')
        WHERE id = ?`,
    ).run(primary.url, primary.number, primary.head_sha, taskId);
  } else {
    db.prepare(
      `UPDATE tasks
          SET pr_url      = NULL,
              pr_number   = NULL,
              pr_head_sha = NULL,
              updated_at  = datetime('now')
        WHERE id = ?`,
    ).run(taskId);
  }

  logger.info({ task_id: taskId, operation: 'syncDerivedPrimaryPr' }, 'derived primary PR synced');
}
