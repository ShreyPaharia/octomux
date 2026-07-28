import type { Task } from '../../types.js';

export interface SetupResult {
  worktreePath: string;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  installHooksAt: string;
}

export type SetupFn = (task: Task) => Promise<SetupResult>;
