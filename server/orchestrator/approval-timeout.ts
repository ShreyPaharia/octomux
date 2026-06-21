/**
 * server/orchestrator/approval-timeout.ts
 *
 * SHR-164 — approval-card timeout fallback.
 *
 * Plan / spec / action approval cards (PlanCard, SpecCard, ActionCard) can sit
 * unanswered forever if the user walks away, leaving
 * `managed_tasks.artifact_lock_owner` held and the run wedged. This sweep
 * auto-rejects pending cards older than a configurable timeout, releases the
 * artifact lock, records the auto-decision in card history, and posts a notice
 * to the conversation.
 *
 * Restart-safe by design: it is a periodic sweep over the durable `action_cards`
 * table (driven by the poller), not an in-memory setTimeout that a process
 * restart would drop. OSS precedent: CrewAI's HITL timeout auto-fallback so an
 * approval can't hang a run.
 *
 * Configuration:
 *   OCTOMUX_APPROVAL_TIMEOUT_MS — per-card approval timeout in ms.
 *                                 Default: 30 minutes (DEFAULT_APPROVAL_TIMEOUT_MS).
 */

import { childLogger } from '../logger.js';
import { listExpiredPendingCards, resolveCard, upsertManagedTask } from './store.js';
import { pushToConversation } from './stream.js';

const logger = childLogger('orchestrator/approval-timeout');

/** Default approval timeout: 30 minutes. Override with OCTOMUX_APPROVAL_TIMEOUT_MS. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolve the configured approval timeout (ms). Falls back to the default. */
export function approvalTimeoutMs(): number {
  const raw = process.env.OCTOMUX_APPROVAL_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * Auto-reject every pending approval card older than the timeout. For each:
 *  - resolve the card to 'auto_rejected' with a reason (the history record),
 *  - release `managed_tasks.artifact_lock_owner` for the card's task (unwedge),
 *  - post a system notice to the conversation.
 *
 * @param timeoutMs - the cutoff; defaults to the configured approval timeout.
 * @returns the number of cards swept.
 */
export function sweepExpiredApprovalCards(timeoutMs: number = approvalTimeoutMs()): number {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const expired = listExpiredPendingCards(timeoutSeconds);
  let swept = 0;

  for (const card of expired) {
    let taskId = '';
    try {
      const parsed = JSON.parse(card.input) as { task_id?: string };
      taskId = typeof parsed.task_id === 'string' ? parsed.task_id : '';
    } catch {
      taskId = '';
    }

    // Record the auto-decision in card history (terminal status + reason).
    resolveCard(
      card.id,
      'auto_rejected',
      JSON.stringify({ auto: true, reason: 'approval timeout', timeout_ms: timeoutMs }),
    );

    // Release the artifact lock so the task is no longer wedged on this card.
    // Partial update — phase and other columns are preserved.
    if (taskId) {
      upsertManagedTask({
        conversation_id: card.conversation_id,
        task_id: taskId,
        artifact_lock_owner: null,
      });
    }

    const minutes = Math.round(timeoutMs / 60000);
    const taskLabel = taskId ? ` for task \`${taskId}\`` : '';
    pushToConversation(
      card.conversation_id,
      JSON.stringify({
        type: 'message',
        role: 'system',
        text:
          `⏱️ Approval card${taskLabel} timed out after ~${minutes}m with no response — ` +
          `auto-rejected and the artifact lock was released. Re-run the action when you're ready.`,
      }),
    );

    logger.info(
      {
        operation: 'approval_timeout_sweep',
        card_id: card.id,
        conversation_id: card.conversation_id,
        task_id: taskId || null,
        tool_name: card.tool_name,
        timeout_ms: timeoutMs,
      },
      'approval card auto-rejected after timeout',
    );
    swept += 1;
  }

  if (swept > 0) {
    logger.info({ operation: 'approval_timeout_sweep', swept }, 'swept expired approval cards');
  }
  return swept;
}
