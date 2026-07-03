import type { DiffTarget } from './types.js';

/**
 * The directory git/diff/file operations should run in for a target: the repo
 * itself when run_mode is `none`, otherwise its dedicated worktree.
 */
export function targetWorkingDir(
  target: Pick<DiffTarget, 'run_mode' | 'repo_path' | 'worktree'>,
): string | null {
  return target.run_mode === 'none' ? target.repo_path : target.worktree;
}
