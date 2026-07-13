import fs from 'fs';
import path from 'path';
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
export function writeLoopStatusFile(worktree: string, record: LoopStatusRecord): void {
  const dir = path.join(worktree, '.octomux');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(worktree, STATUS_REL_PATH), JSON.stringify(record, null, 2) + '\n');
}
