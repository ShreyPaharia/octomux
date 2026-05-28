import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { recordPublishedReview, listPublishedReviews } from './published-reviews.js';

const TASK_ID = 't1';

function insertTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
     VALUES (?, 'x', '', 'idle', 'backlog', 'auto_review')`,
  ).run(TASK_ID);
}

describe('published-reviews', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db);
  });

  it('records a published review and returns the row', () => {
    const row = recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 12345,
      github_review_url: 'https://github.com/o/r/pull/1#pullrequestreview-12345',
      head_sha: 'abc',
      verdict: 'COMMENT',
      comment_count: 3,
    });
    expect(row.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(row.github_review_id).toBe(12345);
    expect(row.published_at).toBeTruthy();
  });

  it('lists newest first', () => {
    recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 1,
      github_review_url: null,
      head_sha: 'a',
      verdict: 'COMMENT',
      comment_count: 1,
    });
    recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 2,
      github_review_url: null,
      head_sha: 'b',
      verdict: 'APPROVE',
      comment_count: 0,
    });
    const all = listPublishedReviews(TASK_ID);
    expect(all.map((r) => r.github_review_id)).toEqual([2, 1]);
  });
});
