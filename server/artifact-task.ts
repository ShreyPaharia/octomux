/**
 * server/artifact-task.ts
 *
 * The database-aware half of the task artifact: resolve a task id to its
 * worktree, then write. Kept OUT of ./artifact.ts so that module stays free of
 * `repositories`/`db` imports — `db/migrations.ts` needs to import the artifact
 * file format during db.ts's own module evaluation, and a `repositories` import
 * there would close an import cycle. See the note at the top of ./artifact.ts.
 */
import type { ArtifactEntry } from '@octomux/plugin-api';
import { childLogger } from './logger.js';
import { getWorktreePathForTask } from './repositories/index.js';
import { setArtifactSummary } from './artifact.js';
import {
  writeArtifact,
  listArtifacts,
  readArtifact,
  type ArtifactRecord,
} from './artifact-files.js';

// Re-exported so callers can name the record type without reaching past this
// module into the fs-only backend.
export type { ArtifactRecord };

/**
 * The ONE `ArtifactRecord` -> `ArtifactEntry` mapper. An `ArtifactRecord` is
 * what's on disk (`server/artifact-files.ts` knows nothing about task ids or
 * HTTP); an `ArtifactEntry` is the wire shape, which adds the url the body is
 * fetched from. It lives here rather than in the route module because all
 * three callers — `plugins/context.ts` (what a plugin's own
 * `ctx.artifacts.write/list` returns), `routes/task-artifacts.ts` and
 * `services/run-detail.ts` — must emit the identical string, and a service
 * importing it from a route would invert the layering.
 */
export function toArtifactEntry(taskId: string, r: ArtifactRecord): ArtifactEntry {
  return {
    ...r,
    url: `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${r.pluginId}/${encodeURIComponent(r.name)}`,
  };
}

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

/**
 * Write a `ctx.artifacts` file for a task by id, resolving its worktree first.
 *
 * Unlike `setTaskSummary` above, this THROWS (does not swallow) when the task
 * is unknown or has no worktree yet. `setTaskSummary` is called from
 * fire-and-forget hook paths where nothing is listening for the result; this
 * is called from a plugin's `ctx.artifacts.write()`, which returns a Promise
 * a plugin author awaits and expects to reject on failure — swallowing the
 * error here would silently no-op a call the plugin thinks succeeded.
 */
export function writeTaskArtifact(
  taskId: string,
  pluginId: string,
  input: { name: string; mime: string; body: string },
): ArtifactRecord {
  const found = getWorktreePathForTask(taskId);
  if (!found?.worktree) {
    throw new Error(`task "${taskId}" has no worktree — cannot write artifact`);
  }
  return writeArtifact(found.worktree, pluginId, input);
}

/** Every artifact for a task, from every plugin. `[]` when the task is
 *  unknown or has no worktree — a read path must not blow up a route handler. */
export function listTaskArtifacts(taskId: string): ArtifactRecord[] {
  const found = getWorktreePathForTask(taskId);
  if (!found?.worktree) return [];
  return listArtifacts(found.worktree);
}

/** One artifact for a task. `null` when the task is unknown, has no worktree,
 *  or the artifact doesn't exist — a read path must not blow up a route handler. */
export function readTaskArtifact(
  taskId: string,
  pluginId: string,
  name: string,
): { record: ArtifactRecord; body: string } | null {
  const found = getWorktreePathForTask(taskId);
  if (!found?.worktree) return null;
  return readArtifact(found.worktree, pluginId, name);
}
