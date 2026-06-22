import type { RunMode } from '../../types.js';
import type { Task } from '../../types.js';
import type { SetupFn, SetupResult } from './types.js';
import { setupNew } from './new.js';
import { setupExisting } from './existing.js';
import { setupNone } from './none.js';
import { setupScratch } from './scratch.js';

export type { SetupResult, SetupFn };

const STRATEGIES: Record<RunMode, SetupFn> = {
  new: setupNew,
  existing: setupExisting,
  none: setupNone,
  scratch: setupScratch,
};

export async function runSetup(task: Task): Promise<SetupResult> {
  const strategy = STRATEGIES[task.run_mode];
  if (!strategy) {
    throw new Error(`unknown run_mode: ${String(task.run_mode)}`);
  }
  return strategy(task);
}
