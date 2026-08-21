import path from 'path';
import type { ComputeSession } from '../../compute/types.js';
import type { LoopRunStatus } from '../../types.js';

export const STATUS_REL_PATH = path.join('.octomux', 'loop-status.json');

export interface LoopStatusRecord {
  loopRunId: string;
  groupId: string | null;
  taskId: string;
  status: LoopRunStatus;
  iteration: number;
  maxIterations: number | null;
  terminationReason: string | null;
  updatedAt: string;
}

/** Explicit, inspectable, recoverable per-run status — written into the candidate's own worktree
 * at every iteration boundary so a best-of-N group's state can be reconstructed by reading each
 * worktree directly, even if a DB write was lost (spec/workflow-framework.md §12). */
export async function writeLoopStatusFile(
  c: ComputeSession,
  worktree: string,
  record: LoopStatusRecord,
): Promise<void> {
  const dir = path.join(worktree, '.octomux');
  await c.files.mkdirp(dir);
  await c.files.write(path.join(worktree, STATUS_REL_PATH), JSON.stringify(record, null, 2) + '\n');
}
