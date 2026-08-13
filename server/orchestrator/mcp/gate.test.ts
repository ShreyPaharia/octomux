/**
 * server/orchestrator/mcp/gate.test.ts
 *
 * Tests for `onGatedInvoke` — the capability registry's ask/always-ask gate
 * (the thing that makes `task.close` etc. actually block on a human instead
 * of running immediately).
 *
 * These assert directly against `onGatedInvoke`'s own return value / thrown
 * error, not a downstream side effect — each one is written to FAIL if the
 * gate is weakened or removed:
 *   - approve resolves (the caller proceeds to the real handler)
 *   - reject / timeout / card-creation-failure all THROW, with three
 *     genuinely distinct messages (never conflated)
 *   - an always-ask capability can NEVER be bypassed by a permission rule,
 *     even when one exists for its exact tool_name
 *   - an ask-tier capability with an existing rule IS bypassed (promotion)
 *   - the kill switch (OCTOMUX_CAPABILITY_GATE_ENABLED=false) bypasses
 *     everything, including always-ask
 *
 * `callGateCard` (the HTTP RPC to the main process) is mocked; the mock
 * implementation exercises the REAL `createCard`/`resolveCard`/`getCard`
 * repository functions against an in-memory DB, so the poll loop in
 * `waitForCardDecision` is exercised for real — only the network hop is
 * faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { createConversation, createCard, resolveCard } from '../../repositories/orchestrator.js';
import { addRule, capabilityToolName } from '../policy.js';
import type { Capability } from '../../registry/types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCallGateCard = vi.fn();
vi.mock('./write.js', () => ({
  callGateCard: (...args: unknown[]) => mockCallGateCard(...args),
}));

// Imported after the mock so gate.ts picks up the mocked write.js.
import { onGatedInvoke } from './gate.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCap(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'task.close',
    summary: 'close a task',
    tier: 'always-ask',
    callers: ['agent'],
    // Only .parse-style consumers ever look at `input`; onGatedInvoke never does.
    input: undefined as never,
    handler: vi.fn(),
    mcp: 'close_task',
    ...overrides,
  };
}

/** Insert a real pending card row, mirroring what /api/hooks/gate-card would create. */
function seedCard(capabilityId: string, tier: 'ask' | 'always-ask', kind: 'action' | 'question') {
  return createCard({
    conversation_id: process.env.OCTOMUX_CONVERSATION_ID!,
    tool_use_id: `gate-${capabilityId}`,
    tool_name: capabilityToolName(capabilityId),
    input: JSON.stringify({ kind, tier, capability_id: capabilityId, args: {} }),
  });
}

describe('onGatedInvoke', () => {
  beforeEach(() => {
    createTestDb();
    mockCallGateCard.mockReset();
    process.env.OCTOMUX_CONVERSATION_ID = createConversation({ title: 'conductor' });
    delete process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;
    delete process.env.OCTOMUX_APPROVAL_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.OCTOMUX_CONVERSATION_ID;
    delete process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;
    delete process.env.OCTOMUX_APPROVAL_TIMEOUT_MS;
    vi.useRealTimers();
  });

  // ── Approve → handler runs ────────────────────────────────────────────────

  it('approve on a write capability resolves undefined — caller proceeds to cap.handler', async () => {
    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('task.close', 'always-ask', 'action');
      resolveCard(cardId, 'approved', null);
      return { card_id: cardId };
    });

    const result = await onGatedInvoke(makeCap(), 'always-ask', { task_id: 't1' });

    expect(result).toBeUndefined();
  });

  it('approve on ask_human short-circuits with the answer — cap.handler never needed', async () => {
    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('human.ask', 'always-ask', 'question');
      resolveCard(cardId, 'approved', JSON.stringify({ answer: 'do it' }));
      return { card_id: cardId };
    });
    const askCap = makeCap({ id: 'human.ask', mcp: 'ask_human' });

    const result = await onGatedInvoke(askCap, 'always-ask', { question: 'proceed?' });

    expect(result).toEqual({ answer: 'do it' });
  });

  // ── Reject → handler does NOT run ─────────────────────────────────────────

  it('reject THROWS — distinct message from timeout and from card-creation failure', async () => {
    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('task.close', 'always-ask', 'action');
      resolveCard(cardId, 'rejected', null);
      return { card_id: cardId };
    });

    await expect(onGatedInvoke(makeCap(), 'always-ask', {})).rejects.toThrow(
      /rejected by the human/,
    );
  });

  // ── Card-creation failure → handler does NOT run, distinct from timeout/reject ──

  it('card-creation RPC failure THROWS a distinct "could not create" error — never a timeout/reject message', async () => {
    mockCallGateCard.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(onGatedInvoke(makeCap(), 'always-ask', {})).rejects.toThrow(
      /could not create an approval card/,
    );

    // The distinguishing property under test: this failure mode must never
    // read like a human decision — assert on the SAME rejection, not a re-run.
    mockCallGateCard.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await onGatedInvoke(makeCap(), 'always-ask', {}).catch((err: Error) => {
      expect(err.message).not.toMatch(/rejected by the human/);
      expect(err.message).not.toMatch(/timed out/);
    });
  });

  // ── Timeout → handler does NOT run, distinct from reject/creation-failure ──

  it('timeout (card never resolved) THROWS a distinct "timed out" error', async () => {
    vi.useFakeTimers();
    process.env.OCTOMUX_APPROVAL_TIMEOUT_MS = '100';
    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('task.close', 'always-ask', 'action');
      // Never resolved — left 'pending' so the poll loop must give up on its
      // own local deadline (approvalTimeoutMs + POLL_GRACE_MS).
      return { card_id: cardId };
    });

    const pending = onGatedInvoke(makeCap(), 'always-ask', {});
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  // ── The security property: always-ask is NEVER promotable ────────────────

  it('an always-ask capability is NEVER auto-approved by a permission rule, even a matching one', async () => {
    // A blanket allow-rule for this EXACT capability id — if the gate were
    // buggy and consulted rules for always-ask too, this would bypass it.
    addRule({ tool_name: capabilityToolName('task.close'), match: null, effect: 'allow' });

    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('task.close', 'always-ask', 'action');
      resolveCard(cardId, 'approved', null);
      return { card_id: cardId };
    });

    await onGatedInvoke(makeCap(), 'always-ask', {});

    // The rule must not have skipped card creation — a card is still required
    // for every always-ask call, rule or no rule.
    expect(mockCallGateCard).toHaveBeenCalledTimes(1);
  });

  it('an ask-tier capability WITH a matching rule IS bypassed (promotion — no card)', async () => {
    addRule({ tool_name: capabilityToolName('task.create'), match: null, effect: 'allow' });
    const cap = makeCap({ id: 'task.create', mcp: 'create_task', tier: 'ask' });

    const result = await onGatedInvoke(cap, 'ask', {});

    expect(result).toBeUndefined();
    expect(mockCallGateCard).not.toHaveBeenCalled();
  });

  it('an ask-tier capability with NO rule still creates a card (not silently bypassed by default)', async () => {
    mockCallGateCard.mockImplementation(async () => {
      const cardId = seedCard('task.create', 'ask', 'action');
      resolveCard(cardId, 'approved', null);
      return { card_id: cardId };
    });
    const cap = makeCap({ id: 'task.create', mcp: 'create_task', tier: 'ask' });

    await onGatedInvoke(cap, 'ask', {});

    expect(mockCallGateCard).toHaveBeenCalledTimes(1);
  });

  // ── Kill switch ────────────────────────────────────────────────────────────

  it('kill switch off bypasses everything, including always-ask — no card', async () => {
    process.env.OCTOMUX_CAPABILITY_GATE_ENABLED = 'false';

    const result = await onGatedInvoke(makeCap(), 'always-ask', {});

    expect(result).toBeUndefined();
    expect(mockCallGateCard).not.toHaveBeenCalled();
  });
});
