import { childLogger } from './logger.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import { getTask } from './repositories/index.js';
import { getReviewRunHeadSha } from './review-runs.js';
import {
  listDraftAcceptedByTask,
  listPublishedAutoResolveCandidates,
  listReflagsInRun,
  markCommentStale,
  setCommentAutoResolved,
} from './inline-comments.js';

const logger = childLogger('review-staleness');

/**
 * Mark drafts/accepted comments stale when the file/line they anchor on has
 * changed between `original_commit_sha` and `newHeadSha` in the task's worktree.
 *
 * Idempotent: only flips draft|accepted → stale, never the other way.
 */
export async function markStaleDrafts(taskId: string, newHeadSha: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || !task.worktree) return;

  const candidates = listDraftAcceptedByTask(taskId, newHeadSha);

  for (const c of candidates) {
    let outdated: boolean;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: c.original_commit_sha,
        newSha: newHeadSha,
        file: c.file_path,
        line: c.line,
        side: c.side,
      });
    } catch (err) {
      logger.warn(
        { task_id: taskId, comment_id: c.id, err: (err as Error).message },
        'staleness check failed; leaving comment unchanged',
      );
      continue;
    }

    if (outdated) {
      markCommentStale(c.id);
      logger.info(
        { task_id: taskId, comment_id: c.id, file: c.file_path, line: c.line },
        'comment marked stale',
      );
    }
  }
}

/**
 * Auto-resolve published comments whose anchored region was modified in the
 * latest review_run's head SHA, when the run did NOT include a re-flag draft
 * pointing at them.
 *
 * Idempotent: only flips published with auto_resolved_at IS NULL → set the
 * resolved fields. Never un-resolves.
 */
export async function autoResolvePublished(taskId: string, runId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || !task.worktree) return;

  const prHeadSha = getReviewRunHeadSha(runId);
  if (prHeadSha === undefined) return;

  const published = listPublishedAutoResolveCandidates(taskId);

  const reflagSet = listReflagsInRun(taskId, runId);

  for (const p of published) {
    if (reflagSet.has(p.id)) continue;

    let outdated: boolean;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: p.original_commit_sha,
        newSha: prHeadSha,
        file: p.file_path,
        line: p.line,
        side: p.side,
      });
    } catch (err) {
      logger.warn(
        { task_id: taskId, comment_id: p.id, err: (err as Error).message },
        'auto-resolve check failed; leaving published comment unchanged',
      );
      continue;
    }

    if (!outdated) continue;

    setCommentAutoResolved(p.id, `line range modified in ${prHeadSha}; no re-flag in run ${runId}`);
    logger.info(
      { task_id: taskId, comment_id: p.id, run_id: runId },
      'published comment auto-resolved',
    );
  }
}
