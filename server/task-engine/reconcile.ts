import path from 'path';
import fs from 'fs';
import { octomuxRoot } from '../octomux-root.js';
import { execTmux } from '../tmux-bin.js';
import { childLogger } from '../logger.js';
import {
  listSettingUpTasks,
  setRuntimeState,
  listActiveScratchTaskIds,
} from '../repositories/index.js';

const logger = childLogger('task-engine/reconcile');

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
      try {
        await execTmux(['has-session', '-t', row.tmux_session]);
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
 */
export async function gcScratchDirs(): Promise<void> {
  const root = scratchRoot();
  if (!fs.existsSync(root)) return;

  const alive = new Set(listActiveScratchTaskIds().map((r) => r.id));

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (alive.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info({ scratch_dir: dir, operation: 'scratch_gc_removed' }, 'scratch_gc_removed');
    } catch (err) {
      logger.warn(
        { scratch_dir: dir, operation: 'scratch_gc_removed', err },
        'scratch_gc_remove_failed',
      );
    }
  }
}
