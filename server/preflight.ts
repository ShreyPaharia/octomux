import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { TaskStatus } from './types.js';

const execFile = promisify(execFileCb);
const logger = childLogger('preflight');

export interface PreflightConflict {
  task_id: string;
  title: string;
  status: TaskStatus;
  branch: string | null;
}

export interface PreflightResult {
  ok: boolean;
  currentBranch: string;
  targetBranch: string;
  conflicts: PreflightConflict[];
  dirty: { count: number } | null;
}

export async function preflightNoneMode(
  repoPath: string,
  baseBranch: string,
): Promise<PreflightResult> {
  const { stdout: headOut } = await execFile('git', [
    '-C',
    repoPath,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const currentBranch = headOut.trim();

  const conflicts: PreflightConflict[] = [];
  let dirty: PreflightResult['dirty'] = null;

  if (currentBranch !== baseBranch) {
    const { stdout: statusOut } = await execFile('git', [
      '-C',
      repoPath,
      'status',
      '--porcelain=v1',
    ]);
    const lines = statusOut.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0) dirty = { count: lines.length };
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.status, w.branch
         FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.status IN ('running', 'setting_up')
          AND w.repo_path = ?
          AND w.branch = ?`,
    )
    .all(repoPath, baseBranch) as PreflightConflict[];
  conflicts.push(...rows);

  const ok = conflicts.length === 0 && dirty === null;
  logger.debug({ repoPath, baseBranch, ok, conflicts: conflicts.length }, 'preflight none mode');
  return { ok, currentBranch, targetBranch: baseBranch, conflicts, dirty };
}
