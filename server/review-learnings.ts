import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { ReviewLearning } from './types.js';

const logger = childLogger('review-learnings');

const DEFAULT_LIST_LIMIT = 50;

export interface AddLearningInput {
  repo_path: string;
  why: string;
  created_from_comment_id?: string | null;
}

export function addLearning(input: AddLearningInput): ReviewLearning {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO review_learnings (id, repo_path, why, created_from_comment_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, input.repo_path, input.why, input.created_from_comment_id ?? null);
  const row = getDb().prepare(`SELECT * FROM review_learnings WHERE id = ?`).get(id) as
    | ReviewLearning
    | undefined;
  if (!row) throw new Error('failed to read review_learning after insert');
  logger.info({ learning_id: id, repo_path: input.repo_path }, 'learning added');
  return row;
}

export function touchLearning(id: string): void {
  getDb()
    .prepare(
      `UPDATE review_learnings
         SET usage_count = usage_count + 1, last_used_at = datetime('now')
       WHERE id = ?`,
    )
    .run(id);
}

export function deleteLearning(id: string): void {
  getDb().prepare(`DELETE FROM review_learnings WHERE id = ?`).run(id);
}

export interface ListLearningsOpts {
  limit?: number;
}

export function listLearningsForRepo(
  repoPath: string,
  opts: ListLearningsOpts = {},
): ReviewLearning[] {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return getDb()
    .prepare(
      `SELECT * FROM review_learnings
         WHERE repo_path = ?
       ORDER BY (last_used_at IS NULL) ASC,
                last_used_at DESC,
                usage_count DESC,
                created_at DESC
       LIMIT ?`,
    )
    .all(repoPath, limit) as ReviewLearning[];
}
