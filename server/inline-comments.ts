import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';

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
}

export interface AddCommentInput {
  task_id: string;
  agent_id?: string | null;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
}

export function addComment(input: AddCommentInput): InlineCommentRow {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO inline_comments
         (id, task_id, agent_id, file_path, line, side, original_commit_sha, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function deleteComment(id: string): boolean {
  const row = getComment(id);
  const result = getDb().prepare(`DELETE FROM inline_comments WHERE id = ?`).run(id);
  if (result.changes > 0 && row) {
    logger.info({ task_id: row.task_id, comment_id: id }, 'inline comment deleted');
    return true;
  }
  return false;
}
