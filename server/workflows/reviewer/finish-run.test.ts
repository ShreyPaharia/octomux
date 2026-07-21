import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertTestTask } from '../../test-helpers.js';
import { getDb } from '../../db.js';
import { insertRun, getRun } from '../../repositories/runs.js';
import { createReviewRun, completeRun } from '../../repositories/review-runs.js';
import { broadcast } from '../../events.js';
import { finishReviewerRun, wireReviewerRunFinisher } from './finish-run.js';
import type { RunResult } from '../../types.js';

describe('finishReviewerRun', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('finishes the runs row with outcome done and comment count on drafts ready', () => {
    insertTestTask({ id: 't1', pr_number: 42, pr_url: 'https://github.com/o/r/pull/42' });
    const runRow = insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: 't1' });
    const reviewRun = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });

    getDb()
      .prepare(
        `INSERT INTO inline_comments
           (id, task_id, file_path, line, side, original_commit_sha, body, review_run_id)
         VALUES ('c1', 't1', 'a.ts', 1, 'new', 'sha1', 'nit', ?),
                ('c2', 't1', 'b.ts', 2, 'new', 'sha1', 'bug', ?)`,
      )
      .run(reviewRun.id, reviewRun.id);

    finishReviewerRun('t1', reviewRun.id, false);

    const finished = getRun(runRow.id)!;
    expect(finished.status).toBe('done');
    expect(finished.ended_at).not.toBeNull();
    const result = JSON.parse(finished.result_json!) as RunResult;
    expect(result.outcome).toBe('done');
    expect(result.summary).toBe('Drafted 2 review comments for PR #42');
    expect(result.links).toEqual([
      { label: 'Review', url: '/reviews/t1' },
      { label: 'PR #42', url: 'https://github.com/o/r/pull/42' },
    ]);
  });

  it('finishes the runs row with outcome failed and error summary', () => {
    insertTestTask({ id: 't1' });
    const runRow = insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: 't1' });
    const reviewRun = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });
    getDb()
      .prepare(`UPDATE review_runs SET status = 'failed', error = ? WHERE id = ?`)
      .run('timeout: no progress for 15 minutes', reviewRun.id);

    finishReviewerRun('t1', reviewRun.id, true);

    const finished = getRun(runRow.id)!;
    expect(finished.status).toBe('failed');
    expect(finished.ended_at).not.toBeNull();
    const result = JSON.parse(finished.result_json!) as RunResult;
    expect(result.outcome).toBe('failed');
    expect(result.summary).toBe('timeout: no progress for 15 minutes');
  });

  it('is a silent no-op when no runs row exists for the task', () => {
    insertTestTask({ id: 't1' });
    const reviewRun = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });
    expect(() => finishReviewerRun('t1', reviewRun.id, false)).not.toThrow();
    expect(getDb().prepare(`SELECT COUNT(*) AS c FROM runs`).get()).toEqual({ c: 0 });
  });
});

describe('wireReviewerRunFinisher', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    createTestDb();
    unsubscribe = wireReviewerRunFinisher();
  });

  afterEach(() => {
    unsubscribe();
  });

  it('finishes the runs row when review:drafts-ready is broadcast', () => {
    insertTestTask({ id: 't1', pr_number: 7, pr_url: 'https://github.com/o/r/pull/7' });
    const runRow = insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: 't1' });
    const reviewRun = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });
    completeRun(reviewRun.id);

    expect(getRun(runRow.id)?.status).toBe('done');
  });

  it('finishes the runs row when review:run-failed is broadcast', () => {
    insertTestTask({ id: 't1' });
    const runRow = insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: 't1' });
    const reviewRun = createReviewRun({ task_id: 't1', pr_head_sha: 'sha1' });
    getDb()
      .prepare(`UPDATE review_runs SET status = 'failed', error = ? WHERE id = ?`)
      .run('agent crashed', reviewRun.id);

    broadcast({ type: 'review:run-failed', payload: { taskId: 't1', reviewRunId: reviewRun.id } });

    const finished = getRun(runRow.id)!;
    expect(finished.status).toBe('failed');
    const result = JSON.parse(finished.result_json!) as RunResult;
    expect(result.outcome).toBe('failed');
    expect(result.summary).toBe('agent crashed');
  });
});
