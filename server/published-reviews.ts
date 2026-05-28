import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { PublishedReview, PublishedReviewVerdict } from './types.js';

const logger = childLogger('published-reviews');

export interface RecordPublishedReviewInput {
  task_id: string;
  github_review_id: number;
  github_review_url: string | null;
  head_sha: string;
  verdict: PublishedReviewVerdict;
  comment_count: number;
}

export function recordPublishedReview(input: RecordPublishedReviewInput): PublishedReview {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO published_reviews
         (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.github_review_id,
      input.github_review_url,
      input.head_sha,
      input.verdict,
      input.comment_count,
    );
  const row = getDb().prepare(`SELECT * FROM published_reviews WHERE id = ?`).get(id) as
    | PublishedReview
    | undefined;
  if (!row) throw new Error('failed to read published_review after insert');
  logger.info(
    { task_id: input.task_id, published_review_id: id, github_review_id: input.github_review_id },
    'published_review recorded',
  );
  return row;
}

export function listPublishedReviews(taskId: string): PublishedReview[] {
  return getDb()
    .prepare(
      `SELECT * FROM published_reviews
         WHERE task_id = ?
         ORDER BY published_at DESC, id DESC`,
    )
    .all(taskId) as PublishedReview[];
}

export function getLatestPublishedReview(taskId: string): PublishedReview | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM published_reviews
         WHERE task_id = ? ORDER BY published_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as PublishedReview | undefined) ?? null
  );
}
