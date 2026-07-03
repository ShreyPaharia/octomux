import {
  listComments,
  markCommentsStaleByIds,
  markCommentsPublishedByIds,
} from './repositories/inline-comments.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import { recordPublishedReview } from './repositories/published-reviews.js';
import { postPullRequestReview } from './github-client.js';
import { broadcast } from './events.js';
import { childLogger } from './logger.js';
import { getTask, inTransaction } from './repositories/index.js';
import type { PublishedReviewVerdict } from './types.js';
import type { InlineCommentRow } from './repositories/inline-comments.js';
import type { PullRequestReviewComment } from './github-client.js';

const logger = childLogger('publish-review');

export interface PublishReviewResult {
  published_review_id: string;
  github_review_url: string | null;
  comment_count: number;
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; pull_number: number } | null {
  // https://github.com/<owner>/<repo>/pull/<number>
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pull_number: parseInt(m[3], 10) };
}

function buildCommentBody(comment: InlineCommentRow): string {
  if (comment.kind === 'suggestion' && comment.suggested_code !== null) {
    return `${comment.body}\n\n\`\`\`suggestion\n${comment.suggested_code}\n\`\`\``;
  }
  return comment.body;
}

export async function publishReview(
  taskId: string,
  verdict: PublishedReviewVerdict,
  reviewBody: string,
): Promise<PublishReviewResult> {
  const task = getTask(taskId);

  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (!task.pr_url || !task.pr_number || !task.pr_head_sha) {
    throw new Error('Task does not have an associated PR');
  }

  const parsed = parsePrUrl(task.pr_url);
  if (!parsed) throw new Error(`Cannot parse PR URL: ${task.pr_url}`);

  // Load accepted comments
  const allComments = listComments(taskId);
  const acceptedComments = allComments.filter((c) => c.status === 'accepted');

  if (acceptedComments.length === 0) {
    throw new Error('No accepted comments to publish');
  }

  const worktree = task.worktree ?? task.repo_path ?? '';

  // Check staleness — flip stale ones; collect fresh ones for publishing
  const freshComments: InlineCommentRow[] = [];
  const staleIds: string[] = [];

  await Promise.all(
    acceptedComments.map(async (c) => {
      const stale = await isAnchorOutdated({
        worktree,
        oldSha: c.original_commit_sha,
        newSha: task.pr_head_sha!,
        file: c.file_path,
        line: c.line,
        side: c.side,
      });
      if (stale) {
        staleIds.push(c.id);
      } else {
        freshComments.push(c);
      }
    }),
  );

  logger.info(
    { task_id: taskId, fresh: freshComments.length, stale: staleIds.length },
    'staleness check complete',
  );

  // Build GitHub API payload
  const ghComments: PullRequestReviewComment[] = freshComments.map((c) => ({
    path: c.file_path,
    line: c.line,
    side: c.side === 'new' ? 'RIGHT' : 'LEFT',
    body: buildCommentBody(c),
  }));

  const reviewResult = await postPullRequestReview({
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.pull_number,
    commit_id: task.pr_head_sha,
    body: reviewBody,
    event: verdict,
    comments: ghComments,
  });

  // Persist in a single transaction
  const publishedReview = inTransaction(() => {
    // Record the published review
    const pr = recordPublishedReview({
      task_id: taskId,
      github_review_id: reviewResult.id,
      github_review_url: reviewResult.html_url,
      head_sha: task.pr_head_sha!,
      verdict,
      comment_count: freshComments.length,
    });

    // Flip stale comments
    if (staleIds.length > 0) {
      markCommentsStaleByIds(staleIds);
    }

    // Flip accepted → published and set published_review_id
    // Note: GitHub doesn't return per-comment IDs in the batch create response,
    // so github_comment_id stays null for now
    if (freshComments.length > 0) {
      const freshIds = freshComments.map((c) => c.id);
      markCommentsPublishedByIds(freshIds, pr.id);
    }

    return pr;
  });

  broadcast({
    type: 'review:published',
    payload: { taskId, github_review_url: publishedReview.github_review_url },
  });

  logger.info(
    {
      task_id: taskId,
      published_review_id: publishedReview.id,
      github_review_id: reviewResult.id,
      comment_count: freshComments.length,
    },
    'review published',
  );

  return {
    published_review_id: publishedReview.id,
    github_review_url: publishedReview.github_review_url,
    comment_count: freshComments.length,
  };
}
