import { getDb } from './db.js';

export interface FileReviewRow {
  task_id: string;
  file_path: string;
  reviewed_at: string;
  reviewed_at_commit: string;
  /**
   * git blob hash of the working-tree content that was approved. Used to detect
   * any change to the displayed (base → working tree) diff since review, whether
   * committed or not. Null on legacy rows recorded before this column existed.
   */
  reviewed_blob_sha: string | null;
}

/**
 * Mark a file as reviewed for a task at the given HEAD commit. `blobSha` is the
 * git blob hash of the reviewed (working-tree) content; pass null when unknown.
 * Upserts on (task_id, file_path) so re-clicking refreshes the timestamp, the
 * commit sha, and the content blob sha.
 */
export function setReviewed(
  taskId: string,
  filePath: string,
  headSha: string,
  blobSha: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO file_review_state (task_id, file_path, reviewed_at, reviewed_at_commit, reviewed_blob_sha)
       VALUES (?, ?, datetime('now'), ?, ?)
       ON CONFLICT(task_id, file_path)
       DO UPDATE SET reviewed_at = datetime('now'),
                     reviewed_at_commit = excluded.reviewed_at_commit,
                     reviewed_blob_sha = excluded.reviewed_blob_sha`,
    )
    .run(taskId, filePath, headSha, blobSha);
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
