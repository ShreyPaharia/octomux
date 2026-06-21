/**
 * server/orchestrator/approval-timeout.test.ts
 *
 * Tests for the approval-card timeout sweep (SHR-164):
 *  - A pending approval card older than the timeout is auto-rejected, its
 *    artifact lock released, and a notice posted to the conversation.
 *  - A fresh (non-expired) pending card is left untouched.
 *  - Non-pending cards are ignored.
 *  - The timeout is configurable (arg + OCTOMUX_APPROVAL_TIMEOUT_MS env).
 *  - A card without a task_id still auto-rejects (no lock to release, no throw).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import {
  createConversation,
  createCard,
  getCard,
  resolveCard,
  upsertManagedTask,
  getManagedTask,
} from './store.js';

// Capture conversation pushes without a ws.
const mockPush = vi.fn();
vi.mock('./stream.js', () => ({
  pushToConversation: vi.fn((_convId: string, msg: string) => mockPush(msg)),
}));

import {
  sweepExpiredApprovalCards,
  approvalTimeoutMs,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from './approval-timeout.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function backdateCard(cardId: string, seconds: number): void {
  getDb()
    .prepare(`UPDATE action_cards SET created_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${seconds} seconds`, cardId);
}

function seedLockedCard(convId: string, taskId: string): string {
  insertTask(getDb(), { id: taskId, worktree: null });
  upsertManagedTask({
    conversation_id: convId,
    task_id: taskId,
    phase: 'awaiting_approval',
    artifact_lock_owner: 'ui',
  });
  return createCard({
    conversation_id: convId,
    tool_use_id: `relay-${taskId}`,
    tool_name: 'approve-plan',
    input: JSON.stringify({ task_id: taskId, plan_path: 'plan.json' }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('approval-timeout sweep (SHR-164)', () => {
  let convId: string;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    delete process.env.OCTOMUX_APPROVAL_TIMEOUT_MS;
    convId = createConversation({ title: 'conv' });
  });

  it('auto-rejects an expired card, releases the lock, and posts a notice', () => {
    const cardId = seedLockedCard(convId, 't1');
    backdateCard(cardId, 3600); // 1h old — past the 30m default

    const swept = sweepExpiredApprovalCards();

    expect(swept).toBe(1);
    expect(getCard(cardId)?.status).toBe('auto_rejected');
    expect(getManagedTask('t1')?.artifact_lock_owner).toBeNull();
    // phase must not be clobbered by the partial update
    expect(getManagedTask('t1')?.phase).toBe('awaiting_approval');
    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse(mockPush.mock.calls[0][0] as string) as { text: string };
    expect(pushed.text).toContain('timed out');
  });

  it('records an auto-decision with a reason in card history', () => {
    const cardId = seedLockedCard(convId, 't1');
    backdateCard(cardId, 3600);

    sweepExpiredApprovalCards();

    const card = getCard(cardId);
    expect(card?.decided_at).not.toBeNull();
    const result = JSON.parse(card?.result ?? '{}') as { auto?: boolean; reason?: string };
    expect(result.auto).toBe(true);
    expect(result.reason).toBe('approval timeout');
  });

  it('leaves a fresh (non-expired) pending card untouched', () => {
    const cardId = seedLockedCard(convId, 't1'); // created just now

    const swept = sweepExpiredApprovalCards();

    expect(swept).toBe(0);
    expect(getCard(cardId)?.status).toBe('pending');
    expect(getManagedTask('t1')?.artifact_lock_owner).toBe('ui');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ignores already-resolved cards even when old', () => {
    const cardId = seedLockedCard(convId, 't1');
    backdateCard(cardId, 3600);
    resolveCard(cardId, 'executed', null);

    const swept = sweepExpiredApprovalCards();

    expect(swept).toBe(0);
    expect(getCard(cardId)?.status).toBe('executed');
  });

  it('respects an explicit timeout argument', () => {
    const cardId = seedLockedCard(convId, 't1');
    backdateCard(cardId, 120); // 2 minutes old

    // 5-minute timeout → not expired yet
    expect(sweepExpiredApprovalCards(5 * 60 * 1000)).toBe(0);
    // 1-minute timeout → now expired
    expect(sweepExpiredApprovalCards(60 * 1000)).toBe(1);
  });

  it('reads the timeout from OCTOMUX_APPROVAL_TIMEOUT_MS, else the default', () => {
    expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    process.env.OCTOMUX_APPROVAL_TIMEOUT_MS = '90000';
    expect(approvalTimeoutMs()).toBe(90000);
    process.env.OCTOMUX_APPROVAL_TIMEOUT_MS = 'not-a-number';
    expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
  });

  it('auto-rejects a card with no task_id without throwing', () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-1',
      tool_name: 'create-task',
      input: JSON.stringify({ title: 'x' }),
    });
    backdateCard(cardId, 3600);

    const swept = sweepExpiredApprovalCards();

    expect(swept).toBe(1);
    expect(getCard(cardId)?.status).toBe('auto_rejected');
  });
});
