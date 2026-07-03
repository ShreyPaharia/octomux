import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { revParseHead } from '../git.js';
import type { Task } from '../../types.js';
import type { SetupResult } from './types.js';

const execFile = promisify(execFileCb);

export async function setupExisting(task: Task): Promise<SetupResult> {
  const worktreePath = task.worktree;
  if (!worktreePath) {
    throw new Error('existing mode requires a worktree path');
  }
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`existing worktree does not exist: ${worktreePath}`);
  }
  await execFile('git', ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree']);

  const baseSha = await revParseHead(worktreePath);

  let branch: string | null = null;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const name = stdout.trim();
    branch = name === 'HEAD' ? null : name;
  } catch {
    branch = null;
  }

  let baseBranch: string | null = null;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const upstream = stdout.trim();
    if (upstream) baseBranch = upstream.replace(/^origin\//, '');
  } catch {
    baseBranch = branch;
  }

  return {
    worktreePath,
    branch,
    baseBranch,
    baseSha,
    installHooksAt: worktreePath,
    runPreflight: false,
  };
}
