import type { Task } from './types.js';

/**
 * The directory git/diff/file operations should run in for a task: the repo
 * itself when the task runs in-place (`run_mode === 'none'`), otherwise its
 * dedicated worktree. Null when no worktree has been created yet.
 */
export function taskWorkingDir(
  task: Pick<Task, 'run_mode' | 'repo_path' | 'worktree'>,
): string | null {
  return task.run_mode === 'none' ? task.repo_path : task.worktree;
}
