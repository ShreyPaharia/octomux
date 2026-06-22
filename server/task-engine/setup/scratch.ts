import fs from 'fs';
import { scratchDirFor } from '../reconcile.js';
import type { Task } from '../../types.js';
import type { SetupResult } from './types.js';

export async function setupScratch(task: Task): Promise<SetupResult> {
  const dir = scratchDirFor(task.id);
  fs.mkdirSync(dir, { recursive: true });

  return {
    worktreePath: dir,
    branch: null,
    baseBranch: null,
    baseSha: null,
    installHooksAt: dir,
    runPreflight: false,
  };
}
