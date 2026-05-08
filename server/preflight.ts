import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { RuntimeState } from './types.js';

const execFile = promisify(execFileCb);
const logger = childLogger('preflight');

export interface PreflightConflict {
  task_id: string;
  title: string;
  runtime_state: RuntimeState;
  branch: string | null;
}

export interface PreflightResult {
  ok: boolean;
  currentBranch: string;
  targetBranch: string;
  /**
   * Active none-mode tasks on the same root worktree but a *different* branch.
   * These block creation because starting the new task would `git checkout`
   * away from their branch and corrupt their working state.
   */
  conflicts: PreflightConflict[];
  /**
   * Active none-mode tasks on the same root worktree on the *same* branch.
   * They share the working tree, which is allowed but worth surfacing so the
   * user can confirm before adding another agent that may step on the others.
   */
  warnings: PreflightConflict[];
  dirty: { count: number } | null;
}

export async function preflightNoneMode(
  repoPath: string,
  baseBranch: string,
  excludeTaskId?: string,
): Promise<PreflightResult> {
  const { stdout: headOut } = await execFile('git', [
    '-C',
    repoPath,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const currentBranch = headOut.trim();

  // Find every active task that is sharing this root worktree (mode='none').
  // 'new'-mode tasks have their own dedicated worktrees and don't conflict.
  // `excludeTaskId` lets the caller skip its own row — needed when this is
  // called as defense-in-depth from inside startTask, where the caller's row
  // is already 'setting_up' but its w.branch is still null pending setup.
  const db = getDb();
  const rows = (
    excludeTaskId
      ? db
          .prepare(
            `SELECT t.id AS task_id, t.title, t.runtime_state, w.branch
             FROM tasks t
             INNER JOIN worktrees w ON t.worktree_id = w.id
            WHERE t.runtime_state IN ('running', 'setting_up')
              AND w.repo_path = ?
              AND w.mode = 'none'
              AND t.id != ?`,
          )
          .all(repoPath, excludeTaskId)
      : db
          .prepare(
            `SELECT t.id AS task_id, t.title, t.runtime_state, w.branch
             FROM tasks t
             INNER JOIN worktrees w ON t.worktree_id = w.id
            WHERE t.runtime_state IN ('running', 'setting_up')
              AND w.repo_path = ?
              AND w.mode = 'none'`,
          )
          .all(repoPath)
  ) as PreflightConflict[];

  const conflicts: PreflightConflict[] = [];
  const warnings: PreflightConflict[] = [];
  for (const row of rows) {
    if (row.branch === baseBranch) warnings.push(row);
    else conflicts.push(row);
  }

  // Dirty matters only when a checkout will actually happen. If conflicts
  // exist we won't get to the checkout anyway — the user will close those
  // tasks first and we'll re-run preflight, at which point dirty (if still
  // present) will be surfaced.
  let dirty: PreflightResult['dirty'] = null;
  if (currentBranch !== baseBranch && conflicts.length === 0) {
    const { stdout: statusOut } = await execFile('git', [
      '-C',
      repoPath,
      'status',
      '--porcelain=v1',
    ]);
    const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0) dirty = { count: lines.length };
  }

  const ok = conflicts.length === 0 && dirty === null;
  logger.debug(
    {
      repoPath,
      baseBranch,
      ok,
      conflicts: conflicts.length,
      warnings: warnings.length,
    },
    'preflight none mode',
  );
  return { ok, currentBranch, targetBranch: baseBranch, conflicts, warnings, dirty };
}
