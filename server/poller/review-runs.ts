import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { findStuckReviewRuns, failReviewRunById } from '../repositories/review-runs.js';

const logger = childLogger('poller');
const REVIEW_RUN_TIMEOUT_MIN = 15;

/**
 * Fail review_runs that have been 'running' for longer than the timeout window
 * without producing a walkthrough or any inline comments. Idempotent.
 */
export async function sweepStuckReviewRuns(): Promise<void> {
  const stuck = findStuckReviewRuns(REVIEW_RUN_TIMEOUT_MIN);

  for (const row of stuck) {
    failReviewRunById(row.id, `timeout: no progress for ${REVIEW_RUN_TIMEOUT_MIN} minutes`);
    logger.warn({ task_id: row.task_id, review_run_id: row.id }, 'review_run timed out');
    broadcast({ type: 'review:run-failed', payload: { taskId: row.task_id, reviewRunId: row.id } });
  }
}
