import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { validateRepo, revParseHead, checkDirty } from '../git.js';
import type { Task } from '../../types.js';
import type { SetupResult } from './types.js';

const execFile = promisify(execFileCb);

export async function setupNone(task: Task): Promise<SetupResult> {
  await validateRepo(task.repo_path);

  const { stdout: headOut } = await execFile('git', [
    '-C',
    task.repo_path,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const currentBranch = headOut.trim();
  const targetBranch = task.base_branch?.trim() || null;

  if (targetBranch) {
    // Defense in depth: re-run preflight inside setup, in case state changed
    // between the API preflight and now. Exclude self — our own worktree row
    // is already 'setting_up' with w.branch=null (it's only set to targetBranch
    // after setup returns), and the row would otherwise self-conflict.
    const { preflightNoneMode } = await import('../../preflight.js');
    const pre = await preflightNoneMode(task.repo_path, targetBranch, task.id);
    if (!pre.ok) {
      const reason = pre.conflicts.length
        ? `another chat is active on a different branch at ${task.repo_path}: ${pre.conflicts
            .map((c) => `${c.task_id} (${c.branch ?? 'unknown'})`)
            .join(', ')}`
        : `working tree at ${task.repo_path} has ${pre.dirty!.count} uncommitted changes`;
      throw new Error(`none mode preflight failed: ${reason}`);
    }
    if (targetBranch !== currentBranch) {
      await execFile('git', ['-C', task.repo_path, 'checkout', targetBranch]);
    }
  } else {
    // Legacy path: no target branch provided, but the tree must still be clean
    // for none mode (preserves existing behavior).
    const dirty = await checkDirty(task.repo_path);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).join(', ');
      const extra = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : '';
      throw new Error(`none mode refuses dirty checkout at ${task.repo_path}: ${preview}${extra}`);
    }
  }

  const finalBranch = targetBranch ?? currentBranch;
  const baseSha = await revParseHead(task.repo_path);

  return {
    worktreePath: task.repo_path,
    branch: finalBranch,
    baseBranch: targetBranch,
    baseSha,
    installHooksAt: task.repo_path,
    runPreflight: false,
  };
}
