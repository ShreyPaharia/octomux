import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { childLogger } from '../logger.js';

const execFile = promisify(execFileCb);
const logger = childLogger('task-engine/git');

export async function validateRepo(repoPath: string): Promise<void> {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }
  await execFile('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
}

export async function revParseHead(cwd: string, ref = 'HEAD'): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', `${ref}^{commit}`]);
  return stdout.trim();
}

export async function checkDirty(repoPath: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['-C', repoPath, 'status', '--porcelain=v1']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** True if `refs/heads/<branch>` exists in the repo. */
export async function gitBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a git worktree, tolerating an already-existing branch so task creation
 * never dies on a name collision (the reported failure: a prior closed task left
 * the branch behind — octomux preserves branches on close).
 *  - branch doesn't exist → create it (`-b <branch> [base]`).
 *  - branch exists, free → check it out into the new worktree (no `-b`; base is
 *    ignored, the branch already has a tip).
 *  - branch exists but is checked out elsewhere (or any other add failure) →
 *    retry with a unique `<branch>-<id>`.
 * Returns the branch name actually used.
 */
export async function addWorktreeWithBranch(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string | null | undefined,
): Promise<string> {
  if (!(await gitBranchExists(repoPath, branch))) {
    const args = ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branch];
    if (baseBranch) args.push(baseBranch);
    await execFile('git', args);
    return branch;
  }

  try {
    await execFile('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branch]);
    logger.info({ operation: 'addWorktree', branch }, 'addWorktree: reused existing branch');
    return branch;
  } catch (err) {
    const unique = `${branch}-${nanoid(6)}`;
    logger.warn(
      { operation: 'addWorktree', branch, unique, err },
      'addWorktree: existing branch unusable (checked out elsewhere?); using unique branch',
    );
    const args = ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', unique];
    if (baseBranch) args.push(baseBranch);
    await execFile('git', args);
    return unique;
  }
}

/** Generate a git-safe branch slug from a title + task ID suffix. */
export function slugifyTitle(title: string, id: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const suffix = id.slice(0, 6);
  return `${slug}-${suffix}`;
}
