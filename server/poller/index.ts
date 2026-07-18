import { childLogger } from '../logger.js';
import { createPoller, type PollerHandle } from './base.js';
import { ensureHooksInstalled } from './hooks.js';
import {
  STATUS_INTERVAL,
  PR_INTERVAL,
  MERGED_PR_INTERVAL,
  DELETE_INTERVAL,
  HANDOFF_INTERVAL,
  APPROVAL_INTERVAL,
  SCHEDULE_INTERVAL,
} from './intervals.js';
import { pollMergedPRs } from './merged-pr.js';
import { pollPRsAndReviewers } from './pr-and-reviewers.js';
import { pollSchedules } from './schedule-cron.js';
import { pollSoftDeletes } from './soft-deletes.js';
import { pollStatuses } from './status.js';
import { pollWalkthroughHandoffs } from './walkthrough-handoff.js';

const logger = childLogger('poller');

let pollers: PollerHandle[] = [];

export function startPolling(): void {
  ensureHooksInstalled();

  pollers = [
    createPoller(pollStatuses, STATUS_INTERVAL),
    createPoller(pollPRsAndReviewers, PR_INTERVAL),
    createPoller(pollMergedPRs, MERGED_PR_INTERVAL),
    createPoller(pollSoftDeletes, DELETE_INTERVAL),
    createPoller(pollWalkthroughHandoffs, HANDOFF_INTERVAL),
    createPoller(pollSchedules, SCHEDULE_INTERVAL),
    createPoller(async () => {
      try {
        const { sweepExpiredApprovalCards } = await import('../orchestrator/approval-timeout.js');
        sweepExpiredApprovalCards();
      } catch (err) {
        logger.error(
          { err, operation: 'sweepExpiredApprovalCards' },
          'approval-timeout sweep failed',
        );
      }
    }, APPROVAL_INTERVAL),
  ];

  for (const poller of pollers) {
    poller.start();
  }
}

export function stopPolling(): void {
  for (const poller of pollers) {
    poller.stop();
  }
  pollers = [];
}

export { checkTaskStatus, pollStatuses } from './status.js';
export { pollTerminalActivity } from './terminal-activity.js';
export { ensureHooksInstalled } from './hooks.js';
export { detectPR, pollPRs } from './pr-detection.js';
export { checkMergedPRs, pollMergedPRs } from './merged-pr.js';
export { pollReviewerRequests } from './reviewer-requests.js';
export { sweepStuckReviewRuns } from './review-runs.js';
export { pollSoftDeletes } from './soft-deletes.js';
export { attachDeepReviewAgent, pollWalkthroughHandoffs } from './walkthrough-handoff.js';
export { pollPRsAndReviewers } from './pr-and-reviewers.js';
export { pollSchedules } from './schedule-cron.js';
export { repoNameWithOwner, parseNameWithOwner } from './github-repo.js';
