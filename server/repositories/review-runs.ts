import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { ReviewRun } from '../types.js';

const logger = childLogger('review-runs');

export interface CreateReviewRunInput {
  task_id: string;
  pr_head_sha: string;
}

export function createReviewRun(input: CreateReviewRunInput): ReviewRun {
  const id = nanoid(12);
  const row = getDb().transaction(() => {
    // A run for a new head replaces any run still chasing an older head —
    // without this, the old row stays 'running' forever (nothing else ever
    // completes it) and the inbox shows a permanent "reviewing".
    const superseded = getDb()
      .prepare(
        `UPDATE review_runs
            SET status = 'failed',
                error = 'superseded by review run for head ' || ?,
                completed_at = datetime('now')
          WHERE task_id = ? AND status = 'running' AND pr_head_sha != ?`,
      )
      .run(input.pr_head_sha, input.task_id, input.pr_head_sha);
    if (superseded.changes > 0) {
      logger.info(
        { task_id: input.task_id, superseded_count: superseded.changes },
        'superseded older running review_runs',
      );
    }
    getDb()
      .prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES (?, ?, ?)`)
      .run(id, input.task_id, input.pr_head_sha);
    return getReviewRun(id);
  })();
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

/** True latest run for the task, including failed ones. */
export function getLatestRun(taskId: string): ReviewRun | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM review_runs
           WHERE task_id = ?
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
  const existing = getReviewRun(id);
  if (!existing || existing.status !== 'running') return;

  getDb()
    .prepare(
      `UPDATE review_runs
         SET status = 'completed',
             walkthrough = COALESCE(?, walkthrough),
             completed_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.walkthrough ?? null, id);

  broadcast({
    type: 'review:drafts-ready',
    payload: { taskId: existing.task_id, reviewRunId: id },
  });
  logger.info(
    { task_id: existing.task_id, review_run_id: id },
    'review_run completed — drafts ready',
  );
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
  reason: 'no-progress' | 'task-not-running' | 'head-advanced';
}

/**
 * Find review_runs that have been 'running' longer than timeoutMinutes and can
 * never complete on their own:
 * - 'no-progress': no walkthrough and no inline comments since they started
 * - 'task-not-running': the task has no live agents left to call `review complete`
 * - 'head-advanced': the PR head moved past the run's sha (a re-review was
 *   requested but a run for the new head never started)
 * Used by poller.sweepStuckReviewRuns.
 */
export function findStuckReviewRuns(timeoutMinutes: number): StuckReviewRun[] {
  return getDb()
    .prepare(
      `SELECT rr.id, rr.task_id,
              CASE
                WHEN rr.walkthrough IS NULL
                     AND NOT EXISTS (
                       SELECT 1 FROM inline_comments ic
                        WHERE ic.review_run_id = rr.id
                          AND ic.created_at > rr.started_at
                     )
                  THEN 'no-progress'
                WHEN t.runtime_state NOT IN ('running', 'setting_up')
                  THEN 'task-not-running'
                ELSE 'head-advanced'
              END AS reason
         FROM review_runs rr
         JOIN tasks t ON t.id = rr.task_id
        WHERE rr.status = 'running'
          AND rr.started_at < datetime('now', ?)
          AND (
            (rr.walkthrough IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM inline_comments ic
                WHERE ic.review_run_id = rr.id
                  AND ic.created_at > rr.started_at
             ))
            OR t.runtime_state NOT IN ('running', 'setting_up')
            OR (t.pr_head_sha IS NOT NULL AND rr.pr_head_sha != t.pr_head_sha)
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
