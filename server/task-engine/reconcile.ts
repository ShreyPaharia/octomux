import path from 'path';
import fs from 'fs';
import { octomuxRoot } from '../octomux-root.js';
import { localSession, sessionFor } from '../compute/index.js';
import { childLogger } from '../logger.js';
import { checkTaskStatus } from '../poller/status.js';
import {
  listSettingUpTasks,
  listRecoverableTasks,
  setRuntimeState,
  setRuntimeStateSetupInterrupted,
  listActiveScratchTaskIds,
  getTask,
} from '../repositories/index.js';
import { resumeTask } from './lifecycle.js';
import { resumeLoopOnStartup } from './loop/engine.js';

const logger = childLogger('task-engine/reconcile');

/**
 * Boot-time task recovery: resume tasks whose runtime_state says they should
 * be running/setting_up/looping but whose tmux session died with the server.
 * Looping tasks are routed through the loop's fresh-context respawn — never
 * the normal `--resume` ladder, which would continue the wrong (non-loop)
 * context.
 */
export async function recoverTasks(): Promise<void> {
  const staleTasks = listRecoverableTasks();

  for (const task of staleTasks) {
    const status = await checkTaskStatus(task);
    if (status === 'alive') continue;

    const compute = await sessionFor(task);

    // Session is dead. Require tmux_session too — without it the task never
    // reached the new-session step, so there's nothing for resumeTask to
    // re-attach to; treat it as an interrupted setup instead.
    if (task.worktree && (await compute.files.exists(task.worktree)) && task.tmux_session) {
      if (task.runtime_state === 'looping') {
        logger.warn({ task_id: task.id, title: task.title }, 'Recovery: resuming loop');
        resumeLoopOnStartup(task).catch((err) => {
          logger.error({ task_id: task.id, err }, 'Recovery: resumeLoopOnStartup failed');
        });
      } else {
        logger.warn({ task_id: task.id, title: task.title }, 'Recovery: resuming task');
        resumeTask(task).catch((err) => {
          logger.error({ task_id: task.id, err }, 'Recovery: resumeTask failed');
        });
      }
    } else if (task.runtime_state === 'setting_up') {
      logger.warn({ task_id: task.id, title: task.title }, 'Recovery: setup was interrupted');
      setRuntimeStateSetupInterrupted(task.id);
    } else {
      logger.warn({ task_id: task.id, title: task.title }, 'Recovery: worktree missing');
      setRuntimeState(task.id, 'error', 'Worktree missing after restart');
    }
  }
}

/** Root directory for scratch-mode task working dirs. */
export function scratchRoot(): string {
  return path.join(octomuxRoot(), 'scratch');
}

export function scratchDirFor(taskId: string): string {
  return path.join(scratchRoot(), taskId);
}

/**
 * Sweep setting_up tasks whose tmux session no longer exists. Transition each
 * to status='error' with a clear error message. Intended to run once at boot.
 */
export async function reconcileOrphanSettingUp(): Promise<void> {
  const rows = listSettingUpTasks();

  for (const row of rows) {
    let alive = false;
    if (row.tmux_session) {
      // `listSettingUpTasks` returns a bare {id, tmux_session} row, not a
      // hydrated Task — rehydrate so a remote task's has-session probe hits
      // its own compute, not the local machine.
      const task = getTask(row.id);
      try {
        const compute = task ? await sessionFor(task) : localSession;
        await compute.tmux(['has-session', '-t', row.tmux_session]);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      setRuntimeState(row.id, 'error', 'orphan setting_up on boot');
      logger.warn(
        { task_id: row.id, operation: 'reconcileOrphanSettingUp' },
        'transitioned orphan setting_up task to error',
      );
    }
  }
}

/**
 * GC scratch dirs that have no matching active task row. A scratch dir is
 * preserved only when a task row with run_mode='scratch' and status in
 * ('draft','setting_up','running') references it.
 *
 * Local-only by construction: `scratchRoot()` is a path under the server's
 * own `octomuxRoot()`, not anywhere a remote compute's scratch dir would
 * live — so this sweep has no per-task session to hydrate and stays on
 * `localSession`.
 */
export async function gcScratchDirs(): Promise<void> {
  const root = scratchRoot();
  if (!(await localSession.files.exists(root))) return;

  const alive = new Set(listActiveScratchTaskIds().map((r) => r.id));

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (alive.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      await localSession.files.rm(dir, { recursive: true });
      logger.info({ scratch_dir: dir, operation: 'scratch_gc_removed' }, 'scratch_gc_removed');
    } catch (err) {
      logger.warn(
        { scratch_dir: dir, operation: 'scratch_gc_removed', err },
        'scratch_gc_remove_failed',
      );
    }
  }
}
