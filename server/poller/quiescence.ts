import { broadcast } from '../events.js';
import { fireHook } from '../hook-dispatcher.js';
import { childLogger } from '../logger.js';
import { isOrchestratorManaged } from '../repositories/orchestrator.js';
import { countPendingByTask } from '../repositories/permission-prompts.js';
import {
  listTasksAwaitingQuiescence,
  setWorkflowStatus,
  addTaskUpdate,
} from '../repositories/tasks.js';
import { QUIESCENCE_DEBOUNCE_MS } from './intervals.js';

const logger = childLogger('poller/quiescence');

/**
 * Periodic sweep: transition tasks from in_progress → human_review once they
 * have been genuinely idle for the quiescence debounce window.
 *
 * A task qualifies when ALL of:
 *   - workflow_status = 'in_progress'
 *   - runtime_state = 'running'
 *   - NOT orchestrator-managed
 *   - has at least one non-stopped worker, and every non-stopped worker has
 *     hook_activity = 'idle' with hook_activity_updated_at older than QUIESCENCE_DEBOUNCE_MS
 *   - countPendingByTask(...) === 0 (no pending permission prompts)
 */
export function pollQuiescence(): void {
  const candidates = listTasksAwaitingQuiescence(QUIESCENCE_DEBOUNCE_MS);

  for (const { id } of candidates) {
    // Skip orchestrator-managed tasks — their workflow_status is authoritative
    // only via set_workflow_status tool, not the quiescence heuristic.
    if (isOrchestratorManaged(id)) {
      logger.info(
        { task_id: id, operation: 'quiescence_skip_managed' },
        'quiescence: skipping orchestrator-managed task',
      );
      continue;
    }

    // Skip if any pending permission prompts are present
    const pending = countPendingByTask(id);
    if (pending > 0) {
      logger.info(
        { task_id: id, pending_prompts: pending, operation: 'quiescence_skip_pending' },
        'quiescence: skipping task with pending permission prompts',
      );
      continue;
    }

    setWorkflowStatus(id, 'human_review');
    addTaskUpdate({
      task_id: id,
      kind: 'transition',
      from_status: 'in_progress',
      to_status: 'human_review',
      body: 'auto: agent stopped',
    });

    logger.info(
      { task_id: id, operation: 'auto_human_review' },
      'auto-transitioned to human_review',
    );

    fireHook('workflow_status_changed', {
      event: 'workflow_status_changed',
      task: { id, workflow_status: 'human_review' as const },
      data: { from: 'in_progress', to: 'human_review', note: 'auto: agent stopped' },
    });

    broadcast({ type: 'task:updated', payload: { taskId: id } });
  }
}
