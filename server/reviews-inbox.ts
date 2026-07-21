import { listPublishedReviews } from './repositories/published-reviews.js';
import { getCurrentRun, listRunsForTask } from './repositories/review-runs.js';
import { listComments, countCommentsByStatus } from './repositories/inline-comments.js';
import { listReviewTasks, getReviewTask } from './repositories/index.js';
import { childLogger } from './logger.js';
import type { Task, ReviewRun, PublishedReview } from './types.js';
import type { InlineCommentRow } from './repositories/inline-comments.js';

const logger = childLogger('reviews-inbox');

export type ReviewInboxStatus =
  | 'reviewing' // a review_run is currently running
  | 'drafts-ready' // latest run completed, drafts await user action
  | 'head-advanced' // PR head SHA differs from latest review_run's SHA
  | 'published' // a published_review exists for the current head SHA and no drafts left
  | 'failed'; // latest run failed

export interface ReviewInboxRow {
  task_id: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_title: string;
  pr_head_sha: string | null;
  author_login: string | null;
  repo_path: string | null;
  status: ReviewInboxStatus;
  draft_count: number;
  accepted_count: number;
  rejected_count: number;
  stale_count: number;
  last_activity_at: string;
}

export interface ReviewDetail {
  task: Task;
  latest_run: ReviewRun | null;
  all_runs: ReviewRun[];
  comments: InlineCommentRow[];
  published_history: PublishedReview[];
}

function deriveStatus(
  task: Task,
  latestRun: ReviewRun | null,
  draftCount: number,
  acceptedCount: number,
): ReviewInboxStatus {
  if (latestRun?.status === 'running') return 'reviewing';
  if (latestRun?.status === 'failed') return 'failed';

  // Head has advanced past the last reviewed SHA
  if (latestRun && task.pr_head_sha && latestRun.pr_head_sha !== task.pr_head_sha) {
    return 'head-advanced';
  }

  if (draftCount > 0 || acceptedCount > 0) return 'drafts-ready';
  return 'published';
}

export function listReviewsInbox(): ReviewInboxRow[] {
  const tasks = listReviewTasks();

  return tasks.map((task) => {
    const latestRun = getCurrentRun(task.id);

    const counts = countCommentsByStatus(task.id);

    const draftCount = counts.draft_count ?? 0;
    const acceptedCount = counts.accepted_count ?? 0;
    const rejectedCount = counts.rejected_count ?? 0;
    const staleCount = counts.stale_count ?? 0;

    const status = deriveStatus(task, latestRun, draftCount, acceptedCount);

    logger.debug(
      { task_id: task.id, status, draft_count: draftCount },
      'reviews-inbox row computed',
    );

    return {
      task_id: task.id,
      pr_number: task.pr_number,
      pr_url: task.pr_url,
      pr_title: task.title,
      pr_head_sha: task.pr_head_sha,
      author_login: null,
      repo_path: task.repo_path ?? null,
      status,
      draft_count: draftCount,
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      stale_count: staleCount,
      last_activity_at: latestRun?.completed_at ?? task.updated_at,
    };
  });
}

export function getReviewDetail(taskId: string): ReviewDetail | null {
  const task = getReviewTask(taskId);

  if (!task) return null;

  const runs = listRunsForTask(taskId);
  const latestRun = runs[0] ?? null;
  const comments = listComments(taskId, { activeOnly: true });
  const publishedHistory = listPublishedReviews(taskId);

  return {
    task,
    latest_run: latestRun,
    all_runs: runs,
    comments,
    published_history: publishedHistory,
  };
}
