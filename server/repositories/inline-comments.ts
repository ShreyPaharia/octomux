import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type {
  CommentBucket,
  CommentKind,
  CommentSeverity,
  CommentStatus,
  LastCheckStatus,
} from '../types.js';

const logger = childLogger('inline-comments');

export interface InlineCommentRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  status: CommentStatus;
  review_run_id: string | null;
  severity: CommentSeverity | null;
  bucket: CommentBucket | null;
  kind: CommentKind;
  existing_code: string | null;
  suggested_code: string | null;
  published_review_id: string | null;
  github_comment_id: number | null;
  re_flag_of: string | null;
  last_check_run_id: string | null;
  last_check_status: LastCheckStatus | null;
  auto_resolved_at: string | null;
  auto_resolved_reason: string | null;
}

export interface AddCommentInput {
  task_id: string;
  agent_id?: string | null;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
  // ── Optional review-orchestrator fields. DB column defaults apply when omitted.
  kind?: CommentKind;
  severity?: CommentSeverity | null;
  bucket?: CommentBucket | null;
  review_run_id?: string | null;
  existing_code?: string | null;
  suggested_code?: string | null;
  re_flag_of?: string | null;
}

export function addComment(input: AddCommentInput): InlineCommentRow {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO inline_comments
         (id, task_id, agent_id, file_path, line, side, original_commit_sha, body,
          kind, severity, bucket, review_run_id, existing_code, suggested_code, re_flag_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.agent_id ?? null,
      input.file_path,
      input.line,
      input.side,
      input.original_commit_sha,
      input.body,
      input.kind ?? 'comment',
      input.severity ?? null,
      input.bucket ?? null,
      input.review_run_id ?? null,
      input.existing_code ?? null,
      input.suggested_code ?? null,
      input.re_flag_of ?? null,
    );
  const row = getComment(id);
  if (!row) {
    throw new Error('Failed to read inline comment after insert');
  }
  logger.info(
    { task_id: input.task_id, comment_id: id, file_path: input.file_path, line: input.line },
    'inline comment created',
  );
  return row;
}

export function listComments(taskId: string, opts?: { file?: string }): InlineCommentRow[] {
  if (opts?.file) {
    return getDb()
      .prepare(
        `SELECT * FROM inline_comments
           WHERE task_id = ? AND file_path = ?
           ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId, opts.file) as InlineCommentRow[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM inline_comments
         WHERE task_id = ?
         ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId) as InlineCommentRow[];
}

export function getComment(id: string): InlineCommentRow | null {
  const row = getDb().prepare(`SELECT * FROM inline_comments WHERE id = ?`).get(id) as
    | InlineCommentRow
    | undefined;
  return row ?? null;
}

export function resolveComment(id: string): InlineCommentRow | null {
  getDb()
    .prepare(
      `UPDATE inline_comments SET resolved_at = datetime('now')
         WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(id);
  const row = getComment(id);
  if (row) {
    logger.info({ task_id: row.task_id, comment_id: id }, 'inline comment resolved');
  }
  return row;
}

export function unresolveComment(id: string): InlineCommentRow | null {
  getDb().prepare(`UPDATE inline_comments SET resolved_at = NULL WHERE id = ?`).run(id);
  const row = getComment(id);
  if (row) {
    logger.info({ task_id: row.task_id, comment_id: id }, 'inline comment unresolved');
  }
  return row;
}

export function updateCommentBody(id: string, body: string): InlineCommentRow | null {
  const result = getDb().prepare(`UPDATE inline_comments SET body = ? WHERE id = ?`).run(body, id);
  if (result.changes === 0) return null;
  const row = getComment(id);
  if (row) {
    logger.info({ task_id: row.task_id, comment_id: id }, 'inline comment body updated');
  }
  return row;
}

export interface UpdateCommentFields {
  status?: import('../types.js').CommentStatus;
  bucket?: import('../types.js').CommentBucket | null;
  kind?: import('../types.js').CommentKind;
  severity?: import('../types.js').CommentSeverity | null;
  existing_code?: string | null;
  suggested_code?: string | null;
}

export function updateCommentFields(
  id: string,
  fields: UpdateCommentFields,
): InlineCommentRow | null {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (fields.status !== undefined) {
    sets.push('status = ?');
    vals.push(fields.status);
  }
  if (fields.bucket !== undefined) {
    sets.push('bucket = ?');
    vals.push(fields.bucket);
  }
  if (fields.kind !== undefined) {
    sets.push('kind = ?');
    vals.push(fields.kind);
  }
  if (fields.severity !== undefined) {
    sets.push('severity = ?');
    vals.push(fields.severity);
  }
  if (fields.existing_code !== undefined) {
    sets.push('existing_code = ?');
    vals.push(fields.existing_code);
  }
  if (fields.suggested_code !== undefined) {
    sets.push('suggested_code = ?');
    vals.push(fields.suggested_code);
  }

  if (sets.length === 0) return getComment(id);

  vals.push(id);
  const result = getDb()
    .prepare(`UPDATE inline_comments SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals);
  if (result.changes === 0) return null;
  const row = getComment(id);
  if (row) {
    logger.info({ task_id: row.task_id, comment_id: id, fields }, 'inline comment fields updated');
  }
  return row;
}

export function deleteComment(id: string): boolean {
  const row = getComment(id);
  const result = getDb().prepare(`DELETE FROM inline_comments WHERE id = ?`).run(id);
  if (result.changes > 0 && row) {
    logger.info({ task_id: row.task_id, comment_id: id }, 'inline comment deleted');
    return true;
  }
  return false;
}

export interface CommentStatusCounts {
  draft_count: number | null;
  accepted_count: number | null;
  rejected_count: number | null;
  stale_count: number | null;
}

/**
 * Aggregate draft/accepted/rejected/stale counts for a task's inline comments.
 * Used by the reviews inbox to derive review status. SUM returns NULL when there
 * are no matching rows (caller coalesces to 0).
 */
export function countCommentsByStatus(taskId: string): CommentStatusCounts {
  return getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
         SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
         SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale_count
       FROM inline_comments WHERE task_id = ?`,
    )
    .get(taskId) as CommentStatusCounts;
}

// ─── Staleness helpers ────────────────────────────────────────────────────────

export interface StalenessCandidate {
  id: string;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
}

/**
 * List draft or accepted comments for a task whose original_commit_sha differs
 * from newHeadSha. Used by markStaleDrafts in review-staleness.ts.
 */
export function listDraftAcceptedByTask(taskId: string, newHeadSha: string): StalenessCandidate[] {
  return getDb()
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status IN ('draft', 'accepted')
          AND original_commit_sha != ?`,
    )
    .all(taskId, newHeadSha) as StalenessCandidate[];
}

/**
 * List published comments for a task where auto_resolved_at is still NULL.
 * Used by autoResolvePublished in review-staleness.ts.
 */
export function listPublishedAutoResolveCandidates(taskId: string): StalenessCandidate[] {
  return getDb()
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status = 'published'
          AND auto_resolved_at IS NULL`,
    )
    .all(taskId) as StalenessCandidate[];
}

/**
 * Return the set of re_flag_of comment ids for comments in a specific run.
 * Used by autoResolvePublished to skip already-re-flagged published comments.
 */
export function listReflagsInRun(taskId: string, runId: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT re_flag_of FROM inline_comments
        WHERE task_id = ? AND review_run_id = ? AND re_flag_of IS NOT NULL`,
    )
    .all(taskId, runId) as Array<{ re_flag_of: string }>;
  return new Set(rows.map((r) => r.re_flag_of));
}

/**
 * Mark a single comment as stale (status = 'stale').
 * Only transitions draft or accepted; no-ops if already stale/published/resolved.
 */
export function markCommentStale(id: string): void {
  getDb().prepare(`UPDATE inline_comments SET status = 'stale' WHERE id = ?`).run(id);
}

/**
 * Set auto_resolved_at + auto_resolved_reason on a published comment.
 * Used by autoResolvePublished when the line range has been modified.
 */
export function setCommentAutoResolved(id: string, reason: string): void {
  getDb()
    .prepare(
      `UPDATE inline_comments
          SET auto_resolved_at = datetime('now'),
              auto_resolved_reason = ?
        WHERE id = ?`,
    )
    .run(reason, id);
}

/**
 * Mark a set of comments stale (status = 'stale') in one statement.
 * Used by publishReview within its persist transaction.
 */
export function markCommentsStaleByIds(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getDb()
    .prepare(`UPDATE inline_comments SET status = 'stale' WHERE id IN (${placeholders})`)
    .run(...ids);
}

/**
 * Flip a set of comments to published and stamp the published_review_id.
 * Used by publishReview within its persist transaction.
 */
export function markCommentsPublishedByIds(ids: string[], publishedReviewId: string): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  getDb()
    .prepare(
      `UPDATE inline_comments
           SET status = 'published', published_review_id = ?
         WHERE id IN (${placeholders})`,
    )
    .run(publishedReviewId, ...ids);
}

export interface SeedInlineCommentInput {
  id: string;
  task_id: string;
  review_run_id: string;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
  kind: CommentKind;
  severity?: string | null;
  bucket?: string | null;
  existing_code?: string | null;
  suggested_code?: string | null;
}

/**
 * Idempotent (INSERT OR IGNORE) seed of an inline comment with status='draft'.
 * Used only by the NODE_ENV=test seed endpoint.
 */
export function seedInlineComment(input: SeedInlineCommentInput): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO inline_comments
         (id, task_id, review_run_id, file_path, line, side, original_commit_sha,
          body, status, kind, severity, bucket, existing_code, suggested_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.task_id,
      input.review_run_id,
      input.file_path,
      input.line,
      input.side,
      input.original_commit_sha,
      input.body,
      input.kind,
      input.severity ?? null,
      input.bucket ?? null,
      input.existing_code ?? null,
      input.suggested_code ?? null,
    );
}
