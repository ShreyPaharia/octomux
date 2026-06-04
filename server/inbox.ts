import { getDb } from './db.js';
import type { Task } from './types.js';

/**
 * Tasks that need the user's attention right now: pending permission prompts,
 * or errored tasks whose error hasn't been viewed.
 */
export function getNeedsYou(): Task[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT t.*
       FROM tasks t
       WHERE t.deleted_at IS NULL
         AND (t.source IS NULL OR t.source <> 'auto_review')
         AND (
           EXISTS (
             SELECT 1 FROM permission_prompts pp
             WHERE pp.task_id = t.id AND pp.status = 'pending'
           )
         OR (
           t.runtime_state = 'error'
           AND (t.last_viewed_at IS NULL OR t.last_viewed_at < t.updated_at)
         )
       )
       ORDER BY t.updated_at DESC`,
    )
    .all() as Task[];
}

/**
 * Closed tasks from the last 7 days that the user hasn't seen since they were
 * updated. Excludes anything already in the needs-you bucket.
 */
export function getActivity(): Task[] {
  return getDb()
    .prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.deleted_at IS NULL
         AND (t.source IS NULL OR t.source <> 'auto_review')
         AND t.runtime_state = 'idle'
         AND (t.last_viewed_at IS NULL OR t.last_viewed_at < t.updated_at)
         AND t.updated_at > datetime('now', '-7 days')
         AND NOT EXISTS (
           SELECT 1 FROM permission_prompts pp
           WHERE pp.task_id = t.id AND pp.status = 'pending'
         )
       ORDER BY t.updated_at DESC
       LIMIT 50`,
    )
    .all() as Task[];
}
