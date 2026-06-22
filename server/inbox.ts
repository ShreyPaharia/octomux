import { listNeedsYouTasks, listActivityTasks } from './repositories/index.js';
import type { Task } from './types.js';

/**
 * Tasks that need the user's attention right now: pending permission prompts,
 * or errored tasks whose error hasn't been viewed.
 */
export function getNeedsYou(): Task[] {
  return listNeedsYouTasks();
}

/**
 * Closed tasks from the last 7 days that the user hasn't seen since they were
 * updated. Excludes anything already in the needs-you bucket.
 */
export function getActivity(): Task[] {
  return listActivityTasks();
}
