import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { createReviewRun, getReviewRun, getCurrentRun, completeRun } from './review-runs.js';

vi.mock('../events.js', () => ({ broadcast: vi.fn() }));

import { broadcast } from '../events.js';

const TASK_ID = 't_task1';

function insertTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
     VALUES (?, 'x', '', 'idle', 'backlog', 'auto_review')`,
  ).run(TASK_ID);
}

describe('review-runs', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db);
    vi.mocked(broadcast).mockClear();
  });

  it('createReviewRun inserts a row with status=running', () => {
    const run = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(run.status).toBe('running');
    expect(run.pr_head_sha).toBe('sha1');
    expect(run.walkthrough).toBeNull();
    expect(run.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
  });

  it('getCurrentRun returns the latest non-failed run for the task', () => {
    createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    const newer = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha2' });
    const current = getCurrentRun(TASK_ID);
    expect(current?.id).toBe(newer.id);
  });

  it('completeRun stores walkthrough JSON, marks completed, and broadcasts drafts-ready', () => {
    const run = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    completeRun(run.id, { walkthrough: '{"global":{}}' });
    const fresh = getReviewRun(run.id);
    expect(fresh?.status).toBe('completed');
    expect(fresh?.walkthrough).toBe('{"global":{}}');
    expect(fresh?.completed_at).not.toBeNull();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'review:drafts-ready',
      payload: { taskId: TASK_ID, reviewRunId: run.id },
    });
  });

  it('unique index prevents two running runs on the same task+sha', () => {
    createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(() => createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' })).toThrow();
  });

  it('failed run on the same sha can be retried (creates a new running row)', () => {
    const a = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    db.prepare(`UPDATE review_runs SET status = 'failed' WHERE id = ?`).run(a.id);
    const b = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('running');
  });

  it('new review_run defaults deep_review_attached to 0', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t1', 'r', '', 'running', 'backlog', 'auto_review')`,
    ).run();
    const run = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });
    expect(run.deep_review_attached).toBe(0);
  });
});
