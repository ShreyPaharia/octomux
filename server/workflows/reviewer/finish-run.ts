/**
 * Finishes the reviewer workflow `runs` row when drafting completes or the
 * review_run fails. Subscribes to in-process events via `wireReviewerRunFinisher`
 * (called from server startup — never at module import time).
 */
import { subscribeServerEvents } from '../../events.js';
import { getTask } from '../../repositories/index.js';
import { getReviewRun } from '../../repositories/review-runs.js';
import { countCommentsForRun } from '../../repositories/inline-comments.js';
import { finishRun, listRunsForWorkflow } from '../../repositories/runs.js';
import { childLogger } from '../../logger.js';
import type { RunResult } from '../../types.js';

const logger = childLogger('workflows/reviewer');

/**
 * Terminal update for the reviewer `runs` row tied to `taskId`. Silently a
 * no-op when no running run row exists (e.g. manual reviews outside the
 * github-triggered path).
 */
export function finishReviewerRun(taskId: string, reviewRunId: string, failed: boolean): void {
  const run = listRunsForWorkflow('reviewer').find(
    (r) => r.task_id === taskId && r.status === 'running',
  );
  if (!run) return;

  if (failed) {
    const reviewRun = getReviewRun(reviewRunId);
    const summary = reviewRun?.error ?? 'Review run failed';
    finishRun(run.id, {
      status: 'failed',
      error: summary,
      result: { outcome: 'failed', summary } satisfies RunResult,
    });
    logger.info(
      { task_id: taskId, run_id: run.id, review_run_id: reviewRunId },
      'reviewer: run finished on failure',
    );
    return;
  }

  const commentCount = countCommentsForRun(reviewRunId);
  const task = getTask(taskId);
  const prSuffix = task?.pr_number != null ? ` for PR #${task.pr_number}` : '';
  const summary = `Drafted ${commentCount} review comment${commentCount === 1 ? '' : 's'}${prSuffix}`;

  const links: RunResult['links'] = [{ label: 'Review', url: `/reviews/${taskId}` }];
  if (task?.pr_url && task.pr_number != null) {
    links.push({ label: `PR #${task.pr_number}`, url: task.pr_url });
  }

  finishRun(run.id, {
    status: 'done',
    result: { outcome: 'done', summary, links } satisfies RunResult,
  });
  logger.info(
    { task_id: taskId, run_id: run.id, review_run_id: reviewRunId, comment_count: commentCount },
    'reviewer: run finished on drafts ready',
  );
}

/** Subscribe to review lifecycle events. Returns unsubscribe — call from server startup only. */
export function wireReviewerRunFinisher(): () => void {
  return subscribeServerEvents((event) => {
    if (event.type === 'review:drafts-ready') {
      finishReviewerRun(event.payload.taskId, event.payload.reviewRunId, false);
    } else if (event.type === 'review:run-failed') {
      finishReviewerRun(event.payload.taskId, event.payload.reviewRunId, true);
    }
  });
}
