import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  createReviewRun,
  getReviewRun,
  getCurrentRun,
  getLatestRun,
  completeRun,
} from './review-runs.js';

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

  it('createReviewRun supersedes an older running run on a different head sha', () => {
    const old = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha-old' });
    const fresh = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha-new' });

    const oldRow = db
      .prepare(`SELECT status, error, completed_at FROM review_runs WHERE id = ?`)
      .get(old.id) as { status: string; error: string | null; completed_at: string | null };
    expect(oldRow.status).toBe('failed');
    expect(oldRow.error).toMatch(/superseded/);
    expect(oldRow.completed_at).not.toBeNull();
    expect(fresh.status).toBe('running');
  });

  it('createReviewRun leaves completed runs and other tasks untouched', () => {
    const done = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha-done' });
    db.prepare(`UPDATE review_runs SET status = 'completed' WHERE id = ?`).run(done.id);
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t_other', 'x', '', 'idle', 'backlog', 'auto_review')`,
    ).run();
    const other = createReviewRun({ task_id: 't_other', pr_head_sha: 'sha-x' });

    createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha-new' });

    const doneRow = db.prepare(`SELECT status FROM review_runs WHERE id = ?`).get(done.id) as {
      status: string;
    };
    expect(doneRow.status).toBe('completed');
    const otherRow = db.prepare(`SELECT status FROM review_runs WHERE id = ?`).get(other.id) as {
      status: string;
    };
    expect(otherRow.status).toBe('running');
  });

  it('getLatestRun returns the latest run including failed ones', () => {
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at)
       VALUES ('r-old', ?, 'sha-1', 'completed', datetime('now', '-10 minutes')),
              ('r-new', ?, 'sha-2', 'failed', datetime('now'))`,
    ).run(TASK_ID, TASK_ID);

    expect(getLatestRun(TASK_ID)?.id).toBe('r-new');
  });

  it('getLatestRun returns null when the task has no runs', () => {
    expect(getLatestRun(TASK_ID)).toBeNull();
  });
});
