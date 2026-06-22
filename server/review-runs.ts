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

export interface SeedReviewRunInput {
  id: string;
  task_id: string;
  pr_head_sha: string;
  walkthrough: string;
}

/**
 * Idempotent (INSERT OR IGNORE) seed of a completed review_run.
 * Used only by the NODE_ENV=test seed endpoint.
 */
export function seedReviewRun(input: SeedReviewRunInput): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO review_runs (id, task_id, pr_head_sha, walkthrough, status, completed_at)
       VALUES (?, ?, ?, ?, 'completed', datetime('now'))`,
    )
    .run(input.id, input.task_id, input.pr_head_sha, input.walkthrough);
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

/**
 * Fetch the pr_head_sha for a review_run (used by staleness checks).
 */
export function getReviewRunHeadSha(id: string): string | undefined {
  const row = getDb().prepare(`SELECT pr_head_sha FROM review_runs WHERE id = ?`).get(id) as
    | { pr_head_sha: string }
    | undefined;
  return row?.pr_head_sha;
}

export interface StuckReviewRun {
  id: string;
  task_id: string;
}

/**
 * Find review_runs that have been 'running' longer than timeoutMinutes without
 * producing a walkthrough or any inline comments since they started.
 * Used by poller.sweepStuckReviewRuns.
 */
export function findStuckReviewRuns(timeoutMinutes: number): StuckReviewRun[] {
  return getDb()
    .prepare(
      `SELECT rr.id, rr.task_id FROM review_runs rr
        WHERE rr.status = 'running'
          AND rr.started_at < datetime('now', ?)
          AND rr.walkthrough IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM inline_comments ic
             WHERE ic.review_run_id = rr.id
               AND ic.created_at > rr.started_at
          )`,
    )
    .all(`-${timeoutMinutes} minutes`) as StuckReviewRun[];
}

/**
 * Fail a review_run — set status='failed', error, completed_at.
 */
export function failReviewRunById(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE review_runs
          SET status = 'failed',
              error = ?,
              completed_at = datetime('now')
        WHERE id = ?`,
    )
    .run(error, id);
}

/**
 * Atomically claim the deep-review handoff for a task:
 * flip deep_review_attached 0→1 only when a walkthrough exists and it's still
 * running and not yet claimed.
 * Returns the number of rows changed (1 = claimed, 0 = already claimed or not eligible).
 */
export function claimDeepReviewAttach(taskId: string): number {
  const info = getDb()
    .prepare(
      `UPDATE review_runs SET deep_review_attached = 1
         WHERE task_id = ? AND walkthrough IS NOT NULL AND status = 'running'
               AND deep_review_attached = 0`,
    )
    .run(taskId);
  return info.changes;
}
