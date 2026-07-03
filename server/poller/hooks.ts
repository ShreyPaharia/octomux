import { installHookSettings } from '../hook-settings.js';
import { listActiveTasksForHooks } from '../repositories/tasks.js';
import { getTaskHookToken } from '../repositories/agent-runtime.js';

/**
 * Ensure hooks are installed in all running task worktrees.
 * Handles tasks created before the hook feature existed.
 */
export async function ensureHooksInstalled(): Promise<void> {
  const runningTasks = listActiveTasksForHooks();

  for (const task of runningTasks) {
    try {
      const row = getTaskHookToken(task.id);
      if (!row) continue;
      await installHookSettings(task.worktree!, task.harness_id, row.hook_token);
    } catch {
      // Non-critical — don't crash the poller
    }
  }
}
