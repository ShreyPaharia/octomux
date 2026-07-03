import { childLogger } from '../logger.js';
import { pollPRs } from './pr-detection.js';
import { pollReviewerRequests } from './reviewer-requests.js';
import { sweepStuckReviewRuns } from './review-runs.js';

const logger = childLogger('poller');

/** Fire both PR-related GitHub polls together to avoid doubling `gh` usage. */
export async function pollPRsAndReviewers(): Promise<void> {
  try {
    await pollPRs();
  } catch (err) {
    logger.error({ err, operation: 'pollPRs' }, 'pollPRs failed');
  }
  try {
    await pollReviewerRequests();
  } catch (err) {
    logger.error({ err, operation: 'pollReviewerRequests' }, 'pollReviewerRequests failed');
  }
  try {
    await sweepStuckReviewRuns();
  } catch (err) {
    logger.error({ err, operation: 'sweepStuckReviewRuns' }, 'sweepStuckReviewRuns failed');
  }
}
