import { getDb } from './db.js';

export interface FileReviewRow {
  task_id: string;
  file_path: string;
  reviewed_at: string;
  reviewed_at_commit: string;
}

/**
 * Mark a file as reviewed for a task at the given HEAD commit.
 * Upserts on (task_id, file_path) so re-clicking refreshes both the
 * timestamp and the commit sha.
 */
export function setReviewed(taskId: string, filePath: string, headSha: string): void {
  getDb()
    .prepare(
      `INSERT INTO file_review_state (task_id, file_path, reviewed_at, reviewed_at_commit)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(task_id, file_path)
       DO UPDATE SET reviewed_at = datetime('now'), reviewed_at_commit = excluded.reviewed_at_commit`,
    )
    .run(taskId, filePath, headSha);
}

/**
 * Clear the reviewed state for a (task_id, file_path). Idempotent — silent
 * no-op when no row exists.
 */
export function clearReviewed(taskId: string, filePath: string): void {
  getDb()
    .prepare(`DELETE FROM file_review_state WHERE task_id = ? AND file_path = ?`)
    .run(taskId, filePath);
}

/**
 * List all reviewed-file rows for a task. Used by the diff endpoint to
 * decorate file entries with their reviewed state and the commit sha
 * captured at click time.
 */
export function listReviewState(taskId: string): FileReviewRow[] {
  return getDb()
    .prepare(`SELECT * FROM file_review_state WHERE task_id = ?`)
    .all(taskId) as FileReviewRow[];
}
