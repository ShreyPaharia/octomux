import {
  listComments,
  listResolvedByRun,
  markCommentsStaleByIds,
  markCommentsPublishedByIds,
  resolveComment,
  setGithubCommentId,
} from '../../repositories/inline-comments.js';
import { isAnchorOutdated } from '../../inline-comments-outdated.js';
import { recordPublishedReview } from '../../repositories/published-reviews.js';
import { getCurrentRun } from '../../repositories/review-runs.js';
import {
  postPullRequestReview,
  listReviewComments,
  replyToReviewComment,
  fetchPrReviewComments,
} from '../../github-client.js';
import { broadcast } from '../../events.js';
import { childLogger } from '../../logger.js';
import { publishCoreRecord } from '../../plugins/records.js';
import { enforcePolicy } from '../../plugins/policy.js';
import { getTask, inTransaction } from '../../repositories/index.js';
import type { PublishedReviewVerdict } from '../../types.js';
import type { InlineCommentRow } from '../../repositories/inline-comments.js';
import type { PullRequestReviewComment } from '../../github-client.js';

const logger = childLogger('publish-review');

const VALID_VERDICTS: PublishedReviewVerdict[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

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

type ParsedPr = { owner: string; repo: string; pull_number: number };

/**
 * Fetch the just-posted review's comments and stamp github_comment_id on the
 * matching rows (the batch create response carries no per-comment ids). Matched
 * by path + exact body — buildCommentBody is byte-for-byte what we sent.
 */
async function backfillGithubCommentIds(
  parsed: ParsedPr,
  reviewId: number,
  freshComments: InlineCommentRow[],
  taskId: string,
): Promise<void> {
  if (freshComments.length === 0) return;
  try {
    const posted = await listReviewComments({ ...parsed, review_id: reviewId });
    const remaining = [...posted];
    for (const c of freshComments) {
      const idx = remaining.findIndex(
        (p) => p.path === c.file_path && p.body === buildCommentBody(c),
      );
      if (idx === -1) continue;
      setGithubCommentId(c.id, remaining[idx].id);
      remaining.splice(idx, 1);
    }
  } catch (err) {
    logger.warn(
      { task_id: taskId, err: (err as Error).message },
      'failed to backfill github_comment_id on published comments',
    );
  }
}

/**
 * For prior published comments the current review run marked `resolved`
 * (via check-previous), post an "Addressed in <sha>" reply on their GitHub
 * thread and stamp resolved_at. Rows without a github_comment_id (published
 * before backfill existed) fall back to matching the PR's review comments by
 * path + body; unmatched ones are logged and skipped.
 */
async function replyToAddressedThreads(
  taskId: string,
  parsed: ParsedPr,
  headSha: string,
  repoPath: string | null,
): Promise<void> {
  const run = getCurrentRun(taskId);
  if (!run) return;
  const resolved = listResolvedByRun(taskId, run.id);
  if (resolved.length === 0) return;

  let prComments: Awaited<ReturnType<typeof fetchPrReviewComments>> | null = null;
  for (const c of resolved) {
    let ghId = c.github_comment_id;
    if (ghId === null && repoPath) {
      prComments ??= await fetchPrReviewComments(repoPath, parsed.pull_number);
      const match = prComments.find(
        (p) => p.path === c.file_path && p.body === buildCommentBody(c),
      );
      if (match) ghId = Number(match.id);
    }
    if (ghId === null) {
      logger.warn(
        { task_id: taskId, comment_id: c.id },
        'resolved comment has no github_comment_id and no match on the PR — skipping thread reply',
      );
      continue;
    }
    try {
      await replyToReviewComment({
        ...parsed,
        comment_id: ghId,
        body: `Addressed in ${headSha}.`,
      });
      resolveComment(c.id);
    } catch (err) {
      logger.warn(
        { task_id: taskId, comment_id: c.id, err: (err as Error).message },
        'failed to reply on addressed review thread',
      );
    }
  }
}

export async function publishReview(
  taskId: string,
  verdict: PublishedReviewVerdict,
  reviewBody: string,
): Promise<PublishReviewResult> {
  const decided = await enforcePolicy('review.publish', {
    taskId,
    data: { verdict, bodyLength: reviewBody.length },
  });
  if (
    typeof decided.verdict === 'string' &&
    VALID_VERDICTS.includes(decided.verdict as PublishedReviewVerdict)
  ) {
    verdict = decided.verdict as PublishedReviewVerdict;
  } else if (decided.verdict !== undefined && decided.verdict !== verdict) {
    logger.warn(
      { task_id: taskId, patched_verdict: decided.verdict },
      'publishReview: ignoring invalid patched verdict from policy hook',
    );
  }

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

  // Post-publish GitHub thread work. The review is already posted and
  // persisted — a failure here is logged, never thrown.
  await backfillGithubCommentIds(parsed, reviewResult.id, freshComments, taskId);
  await replyToAddressedThreads(taskId, parsed, task.pr_head_sha, task.repo_path ?? null);

  broadcast({
    type: 'review:published',
    payload: { taskId, github_review_url: publishedReview.github_review_url },
  });

  // The one real `core:` record producer today (SHR-255's "Done when": a
  // plugin subscribes to a core record and fires on it). Same payload shape
  // as the broadcast above. A records-log failure must not undo a review
  // that's already posted to GitHub and persisted — log and move on, never throw.
  try {
    publishCoreRecord('core:review.published', taskId, {
      taskId,
      github_review_url: publishedReview.github_review_url,
    });
  } catch (err) {
    logger.warn({ task_id: taskId, err }, 'failed to publish core:review.published record');
  }

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
