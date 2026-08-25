import { getSettings } from '../settings.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { deleteTask } from '../task-engine/index.js';
import { listExpiredSoftDeletes, hardDeleteTask } from '../repositories/tasks.js';

const logger = childLogger('poller');

export async function pollSoftDeletes(): Promise<void> {
  let hours: number;
  try {
    const settings = await getSettings();
    hours = Math.max(0, settings.deleteGraceHours ?? 6);
  } catch (err) {
    logger.warn({ err, operation: 'pollSoftDeletes' }, 'could not read settings; using default 6h');
    hours = 6;
  }

  const rows = listExpiredSoftDeletes(hours);

  for (const task of rows) {
    try {
      const report = await deleteTask(task);
      if (report.errors.length > 0) {
        // The row is about to be hard-deleted — this is the only surviving
        // record that the teardown left something behind (a leaked worktree
        // or branch), so log it as an error before that happens.
        logger.error(
          { task_id: task.id, operation: 'pollSoftDeletes', report },
          'deleteTask left the worktree/branch behind; hard-deleting the row anyway',
        );
      }
      // Still hard-delete even on a teardown failure — a permanently
      // unremovable worktree must not wedge the trash queue forever.
      hardDeleteTask(task.id);
      broadcast({ type: 'task:deleted', payload: { taskId: task.id } });
      logger.info({ task_id: task.id, operation: 'pollSoftDeletes' }, 'purged soft-deleted task');
    } catch (err) {
      logger.error(
        { err, task_id: task.id, operation: 'pollSoftDeletes' },
        'purge failed; will retry next tick',
      );
    }
  }
}
