import { getDb } from './db.js';
import { childLogger } from './logger.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import { SELECT_TASK_SQL } from './task-select.js';
import type { Task } from './types.js';

const logger = childLogger('review-staleness');

interface DraftRow {
  id: string;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
}

type PublishedRow = DraftRow;

/**
 * Mark drafts/accepted comments stale when the file/line they anchor on has
 * changed between `original_commit_sha` and `newHeadSha` in the task's worktree.
 *
 * Idempotent: only flips draft|accepted → stale, never the other way.
 */
export async function markStaleDrafts(taskId: string, newHeadSha: string): Promise<void> {
  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree) return;

  const candidates = db
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status IN ('draft', 'accepted')
          AND original_commit_sha != ?`,
    )
    .all(taskId, newHeadSha) as DraftRow[];

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
      db.prepare(`UPDATE inline_comments SET status = 'stale' WHERE id = ?`).run(c.id);
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
  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree) return;

  const run = db.prepare(`SELECT pr_head_sha FROM review_runs WHERE id = ?`).get(runId) as
    | { pr_head_sha: string }
    | undefined;
  if (!run) return;

  const published = db
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status = 'published'
          AND auto_resolved_at IS NULL`,
    )
    .all(taskId) as PublishedRow[];

  const reflagSet = new Set(
    (
      db
        .prepare(
          `SELECT re_flag_of FROM inline_comments
          WHERE task_id = ? AND review_run_id = ? AND re_flag_of IS NOT NULL`,
        )
        .all(taskId, runId) as { re_flag_of: string }[]
    ).map((r) => r.re_flag_of),
  );

  for (const p of published) {
    if (reflagSet.has(p.id)) continue;

    let outdated: boolean;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: p.original_commit_sha,
        newSha: run.pr_head_sha,
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

    db.prepare(
      `UPDATE inline_comments
          SET auto_resolved_at = datetime('now'),
              auto_resolved_reason = ?
        WHERE id = ?`,
    ).run(`line range modified in ${run.pr_head_sha}; no re-flag in run ${runId}`, p.id);
    logger.info(
      { task_id: taskId, comment_id: p.id, run_id: runId },
      'published comment auto-resolved',
    );
  }
}
