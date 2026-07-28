import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { findStuckReviewRuns, failReviewRunById } from '../repositories/review-runs.js';

const logger = childLogger('poller');
const REVIEW_RUN_TIMEOUT_MIN = 15;

const STUCK_ERRORS: Record<string, string> = {
  'no-progress': `timeout: no progress for ${REVIEW_RUN_TIMEOUT_MIN} minutes`,
  'task-not-running': `timeout: task no longer running after ${REVIEW_RUN_TIMEOUT_MIN} minutes`,
  'head-advanced': 'superseded: PR head advanced without a new review run',
};

/**
 * Fail review_runs that have been 'running' past the timeout window and can
 * never complete on their own (no progress, task's agents gone, or the PR head
 * advanced without a replacement run). Idempotent.
 */
export async function sweepStuckReviewRuns(): Promise<void> {
  const stuck = findStuckReviewRuns(REVIEW_RUN_TIMEOUT_MIN);

  for (const row of stuck) {
    failReviewRunById(row.id, STUCK_ERRORS[row.reason] ?? STUCK_ERRORS['no-progress']);
    logger.warn(
      { task_id: row.task_id, review_run_id: row.id, reason: row.reason },
      'review_run swept as stuck',
    );
    broadcast({ type: 'review:run-failed', payload: { taskId: row.task_id, reviewRunId: row.id } });
  }
}
