import { scratchDirFor } from '../reconcile.js';
import type { ComputeSession } from '../../compute/types.js';
import type { Task } from '../../types.js';
import type { SetupResult } from './types.js';

export async function setupScratch(c: ComputeSession, task: Task): Promise<SetupResult> {
  const dir = scratchDirFor(task.id);
  await c.files.mkdirp(dir);

  return {
    worktreePath: dir,
    branch: null,
    baseBranch: null,
    baseSha: null,
    installHooksAt: dir,
  };
}
