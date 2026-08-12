/**
 * server/artifact-task.ts
 *
 * The database-aware half of the task artifact: resolve a task id to its
 * worktree, then write. Kept OUT of ./artifact.ts so that module stays free of
 * `repositories`/`db` imports — `db/migrations.ts` needs to import the artifact
 * file format during db.ts's own module evaluation, and a `repositories` import
 * there would close an import cycle. See the note at the top of ./artifact.ts.
 */
import { childLogger } from './logger.js';
import { getWorktreePathForTask } from './repositories/index.js';
import { setArtifactSummary } from './artifact.js';

const logger = childLogger('artifact-task');

/**
 * Set a task's summary by id, resolving its worktree first. No-op (logged at
 * debug) if the task has no worktree yet. All errors are swallowed — this is
 * called from fire-and-forget hook paths that must never throw.
 *
 * ponytail: writes the file synchronously on every call. The hottest caller
 * (POST /api/hooks/post-tool-use) fires this on every tool use, not just at
 * Stop — fine at today's one-small-file-per-task scale; if rapid-fire tool
 * calls make this measurably hot, debounce/coalesce writes per task instead.
 */
export function setTaskSummary(taskId: string, summary: string): void {
  try {
    const found = getWorktreePathForTask(taskId);
    if (!found?.worktree) {
      logger.debug({ task_id: taskId }, 'setTaskSummary skipped: task has no worktree yet');
      return;
    }
    setArtifactSummary(found.worktree, summary);
  } catch (err) {
    logger.warn({ task_id: taskId, err }, 'setTaskSummary failed to write artifact');
  }
}
