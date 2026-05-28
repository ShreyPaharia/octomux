import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { ReviewRun } from './types.js';

const logger = childLogger('review-runs');

export interface CreateReviewRunInput {
  task_id: string;
  pr_head_sha: string;
}

export function createReviewRun(input: CreateReviewRunInput): ReviewRun {
  const id = nanoid(12);
  getDb()
    .prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES (?, ?, ?)`)
    .run(id, input.task_id, input.pr_head_sha);
  const row = getReviewRun(id);
  if (!row) throw new Error('failed to read review_run after insert');
  logger.info(
    { task_id: input.task_id, review_run_id: id, pr_head_sha: input.pr_head_sha },
    'review_run created',
  );
  return row;
}

export function getReviewRun(id: string): ReviewRun | null {
  return (
    (getDb().prepare(`SELECT * FROM review_runs WHERE id = ?`).get(id) as ReviewRun | undefined) ??
    null
  );
}

/** Latest non-failed run for the task (running OR completed). */
export function getCurrentRun(taskId: string): ReviewRun | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM review_runs
           WHERE task_id = ? AND status != 'failed'
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as ReviewRun | undefined) ?? null
  );
}

export function listRunsForTask(taskId: string): ReviewRun[] {
  return getDb()
    .prepare(`SELECT * FROM review_runs WHERE task_id = ? ORDER BY started_at DESC`)
    .all(taskId) as ReviewRun[];
}

export interface CompleteRunInput {
  walkthrough?: string;
}

export function completeRun(id: string, input: CompleteRunInput = {}): void {
  getDb()
    .prepare(
      `UPDATE review_runs
         SET status = 'completed',
             walkthrough = COALESCE(?, walkthrough),
             completed_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.walkthrough ?? null, id);
}

export function failRun(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE review_runs
         SET status = 'failed', error = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(error, id);
}

export function setWalkthrough(id: string, walkthroughJson: string): void {
  getDb().prepare(`UPDATE review_runs SET walkthrough = ? WHERE id = ?`).run(walkthroughJson, id);
}
