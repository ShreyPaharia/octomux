import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { getDb } from './db.js';
import { listReviewsInbox, getReviewDetail } from './reviews-inbox.js';

function seedRepo(): void {
  createTestDb();
  const db = getDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_url, pr_number, pr_head_sha)
     VALUES
       ('t1', 'PR review', '', 'running', 'backlog', 'auto_review', 'wt1',
        'https://github.com/o/r/pull/1', 1, 'sha-h')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, walkthrough, status, completed_at)
     VALUES ('r1', 't1', 'sha-h', '{"global":{}}', 'completed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, review_run_id, severity, bucket)
     VALUES
       ('c1', 't1', 'a.ts', 1, 'new', 'sha-h', 'b', 'draft', 'comment', 'r1', 'issue', 'actionable'),
       ('c2', 't1', 'a.ts', 2, 'new', 'sha-h', 'b', 'accepted', 'comment', 'r1', 'nit', 'actionable'),
       ('c3', 't1', 'a.ts', 3, 'new', 'sha-h', 'b', 'rejected', 'comment', 'r1', 'nit', 'actionable')`,
  ).run();
}

describe('reviews-inbox', () => {
  beforeEach(seedRepo);

  it('listReviewsInbox returns one row per auto_review task with counts', () => {
    const list = listReviewsInbox();
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row.task_id).toBe('t1');
    expect(row.pr_number).toBe(1);
    expect(row.draft_count).toBe(1);
    expect(row.accepted_count).toBe(1);
    expect(row.rejected_count).toBe(1);
    expect(row.status).toBe('drafts-ready'); // accepted > 0 OR drafts > 0 AND latest run completed
  });

  it('getReviewDetail returns task + latest run + comments + published history', () => {
    const detail = getReviewDetail('t1');
    expect(detail).not.toBeNull();
    expect(detail!.task.id).toBe('t1');
    expect(detail!.latest_run?.id).toBe('r1');
    expect(detail!.comments.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(detail!.published_history).toEqual([]);
  });

  it('getReviewDetail returns null for unknown task', () => {
    expect(getReviewDetail('nope')).toBeNull();
  });

  it('getReviewDetail returns null for a non-auto_review task', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t2', 'regular', '', 'idle', 'backlog', NULL)`,
    ).run();
    expect(getReviewDetail('t2')).toBeNull();
  });
});
