/**
 * server/orchestrator/gate.test.ts
 *
 * Tests for Task 3.2 / SHR-131 — Bash PreToolUse deny-now gate.
 *
 * Covers:
 *  1. handlePreToolUse: ask-tier → deny + creates action_cards row + pushes card event.
 *  2. handlePreToolUse: always-ask tier → deny + creates card.
 *  3. handlePreToolUse: auto-allow tier → allow response (no card).
 *  4. handlePreToolUse: allow rule promotes ask → auto (no card).
 *  5. handlePreToolUse: missing conversation_id → allow (failsafe: no gate without context).
 *  6. executeCard: Approve runs the op server-side + resolves card to 'executed'.
 *  7. executeCard: Reject resolves card to 'rejected', no exec.
 *  8. executeCard: Edit runs op with adjusted args + resolves to 'executed'.
 *  9. rehydratePendingCards: returns all pending cards across conversations.
 * 10. POST /api/hooks/pre-tool-use: full HTTP round-trip (supertest).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createTestDb, insertTask, insertAgent } from '../test-helpers.js';
import { createConversation, getCard, listPendingCards, createCard, resolveCard } from './store.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock exec so we don't need real task-runner / tmux
const mockRunCreateTask = vi.fn().mockResolvedValue({ task_id: 'new-task-id', title: 'Test Task' });
const mockRunSendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('./exec.js', () => ({
  runCreateTask: vi.fn((...args: unknown[]) => mockRunCreateTask(...args)),
  runSendMessage: vi.fn((...args: unknown[]) => mockRunSendMessage(...args)),
  validatePlanJson: vi.fn().mockReturnValue({ valid: true }),
  PLAN_SCHEMA_VERSION: '1.0.0',
  PLAN_KIND: 'plan',
}));

// Mock stream to capture pushed events without real WS
const mockPushToConversation = vi.fn();
vi.mock('./stream.js', () => ({
  pushToConversation: vi.fn((...args: unknown[]) => mockPushToConversation(...args)),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
  setupOrchestratorWebSocket: vi.fn(),
  handleOrchestratorUpgrade: vi.fn().mockReturnValue(false),
  getOrchestratorClientCount: vi.fn().mockReturnValue(0),
  cleanupOrchestratorClients: vi.fn(),
  chatEventToWsEvent: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { handlePreToolUse, executeCard, rehydratePendingCards } from './gate.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConversation(title = 'Test Conversation'): string {
  return createConversation({ title });
}

/** Build a minimal PreToolUse hook body for an octomux Bash command. */
function bashBody(subcommand: string, extraArgs = ''): Record<string, unknown> {
  const command = extraArgs ? `octomux ${subcommand} ${extraArgs}` : `octomux ${subcommand}`;
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('gate.handlePreToolUse', () => {
  let convId: string;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    convId = makeConversation();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ask-tier command → deny + creates action_cards row', async () => {
    const result = await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'Bash',
      tool_input: { command: 'octomux create-task --title "Fix bug"' },
      tool_use_id: 'tu-001',
    });

    expect(result.decision).toBe('deny');
    expect(result.card_id).toBeTruthy();

    // Card must be persisted
    const card = getCard(result.card_id!);
    expect(card).toBeDefined();
    expect(card!.conversation_id).toBe(convId);
    expect(card!.status).toBe('pending');
    expect(card!.tool_name).toBe('Bash');
  });

  it('ask-tier → pushed a card ws event to the conversation', async () => {
    await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'Bash',
      tool_input: { command: 'octomux create-task --title "Fix bug"' },
      tool_use_id: 'tu-002',
    });

    expect(mockPushToConversation).toHaveBeenCalledOnce();
    const pushed = JSON.parse(mockPushToConversation.mock.calls[0][1] as string);
    expect(pushed.type).toBe('card');
    expect(pushed.id).toBeTruthy();
  });

  it('always-ask tier (delete-task) → deny + creates card', async () => {
    const result = await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'Bash',
      tool_input: { command: 'octomux delete-task --task abc123' },
      tool_use_id: 'tu-003',
    });

    expect(result.decision).toBe('deny');
    expect(result.card_id).toBeTruthy();
    const card = getCard(result.card_id!);
    expect(card!.status).toBe('pending');
  });

  it('auto-allow tier (list_tasks MCP read) → allow + no card', async () => {
    const result = await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'list_tasks',
      tool_input: {},
      tool_use_id: 'tu-004',
    });

    expect(result.decision).toBe('allow');
    expect(result.card_id).toBeUndefined();
    expect(mockPushToConversation).not.toHaveBeenCalled();
    // No card row
    expect(listPendingCards(convId)).toHaveLength(0);
  });

  it('allow rule promotes ask → auto (no card)', async () => {
    // Insert an allow rule for create-task
    const { addRule } = await import('./policy.js');
    addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'allow' });

    const result = await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'Bash',
      tool_input: { command: 'octomux create-task --title "Allowed"' },
      tool_use_id: 'tu-005',
    });

    expect(result.decision).toBe('allow');
    expect(result.card_id).toBeUndefined();
    expect(listPendingCards(convId)).toHaveLength(0);
  });

  it('missing conversation_id → allow (failsafe — no gate without context)', async () => {
    const result = await handlePreToolUse({
      conversation_id: undefined,
      tool_name: 'Bash',
      tool_input: { command: 'octomux create-task --title "No conv"' },
      tool_use_id: 'tu-006',
    });

    expect(result.decision).toBe('allow');
    expect(result.card_id).toBeUndefined();
  });

  it('non-octomux bash command with no conversation → allow (passthrough)', async () => {
    const result = await handlePreToolUse({
      conversation_id: undefined,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_use_id: 'tu-007',
    });

    expect(result.decision).toBe('allow');
  });
});

// ─── executeCard ──────────────────────────────────────────────────────────────

describe('gate.executeCard', () => {
  let convId: string;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    convId = makeConversation();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function insertPendingCard(input?: string): string {
    return createCard({
      conversation_id: convId,
      tool_use_id: 'tu-exec-001',
      tool_name: 'Bash',
      input: input ?? JSON.stringify({ command: 'octomux create-task --title "Test"' }),
    });
  }

  it('Approve → runs the op + resolves card to executed', async () => {
    const cardId = insertPendingCard();

    await executeCard({ card_id: cardId, decision: 'approve' });

    const card = getCard(cardId)!;
    expect(card.status).toBe('executed');
    expect(card.decided_at).not.toBeNull();
    expect(card.result).not.toBeNull();

    // exec was called
    expect(mockRunCreateTask).toHaveBeenCalled();

    // A confirmation note was pushed to the conversation
    expect(mockPushToConversation).toHaveBeenCalled();
  });

  it('Reject → resolves card to rejected without running the op', async () => {
    const cardId = insertPendingCard();

    await executeCard({ card_id: cardId, decision: 'reject', respond_text: 'Not now' });

    const card = getCard(cardId)!;
    expect(card.status).toBe('rejected');
    expect(mockRunCreateTask).not.toHaveBeenCalled();

    // Rejection note pushed
    expect(mockPushToConversation).toHaveBeenCalled();
    const pushed = JSON.parse(mockPushToConversation.mock.calls[0][1] as string);
    expect(pushed.type).toBe('message');
    expect(pushed.text).toContain('rejected');
  });

  it('Edit → runs the op with overridden command + resolves to executed', async () => {
    const cardId = insertPendingCard(
      JSON.stringify({ command: 'octomux create-task --title "Original"' }),
    );

    await executeCard({
      card_id: cardId,
      decision: 'edit',
      edited_input: { command: 'octomux create-task --title "Edited"' },
    });

    const card = getCard(cardId)!;
    expect(card.status).toBe('executed');
    expect(mockRunCreateTask).toHaveBeenCalled();
  });

  it('no-ops gracefully when card_id does not exist', async () => {
    await expect(
      executeCard({ card_id: 'nonexistent', decision: 'approve' }),
    ).resolves.not.toThrow();
    expect(mockRunCreateTask).not.toHaveBeenCalled();
  });

  it('no-ops when card is already resolved (idempotent)', async () => {
    const cardId = insertPendingCard();
    resolveCard(cardId, 'executed', JSON.stringify({ ok: true }));

    await executeCard({ card_id: cardId, decision: 'approve' });

    // exec should NOT run again
    expect(mockRunCreateTask).not.toHaveBeenCalled();
  });
});

// ─── rehydratePendingCards ────────────────────────────────────────────────────

describe('gate.rehydratePendingCards', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns all pending cards across conversations on boot', () => {
    const c1 = createConversation({ title: 'Conv 1' });
    const c2 = createConversation({ title: 'Conv 2' });

    createCard({ conversation_id: c1, tool_use_id: 'tu-r1', tool_name: 'Bash', input: '{}' });
    createCard({ conversation_id: c2, tool_use_id: 'tu-r2', tool_name: 'Bash', input: '{}' });
    const cardId3 = createCard({
      conversation_id: c1,
      tool_use_id: 'tu-r3',
      tool_name: 'Bash',
      input: '{}',
    });
    // Resolve one so it's not pending anymore
    resolveCard(cardId3, 'rejected', null);

    const pending = rehydratePendingCards();
    expect(pending).toHaveLength(2);
    expect(pending.every((c) => c.status === 'pending')).toBe(true);
  });

  it('returns empty array when no pending cards', () => {
    expect(rehydratePendingCards()).toHaveLength(0);
  });
});

// ─── POST /api/hooks/pre-tool-use (HTTP round-trip) ──────────────────────────

describe('POST /api/hooks/pre-tool-use', () => {
  let app: ReturnType<typeof createApp>;
  let convId: string;

  beforeEach(() => {
    const db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
    convId = createConversation({ title: 'Test Conv' });

    // Insert an agent so the hook_token auth check passes
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, {
      id: 'a1',
      task_id: 't1',
      harness_session_id: 'sess-hook',
      hook_token: 'tok-gate',
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no token', async () => {
    await request(app).post('/api/hooks/pre-tool-use').send(bashBody('create-task')).expect(401);
  });

  it('ask-tier → 200 with hookSpecificOutput deny', async () => {
    const res = await request(app)
      .post(`/api/hooks/pre-tool-use?token=tok-gate&conversation_id=${convId}`)
      .send(bashBody('create-task', '--title "Fix bug"'))
      .expect(200);

    expect(res.body).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(typeof res.body.hookSpecificOutput.permissionDecisionReason).toBe('string');
    expect(res.body.hookSpecificOutput.permissionDecisionReason).toContain('card');
  });

  it('auto-allow tier → 200 with allow decision', async () => {
    const res = await request(app)
      .post(`/api/hooks/pre-tool-use?token=tok-gate&conversation_id=${convId}`)
      .send({
        hook_event_name: 'PreToolUse',
        tool_name: 'list_tasks',
        tool_input: {},
      })
      .expect(200);

    expect(res.body).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('always-ask tier (close-task) → 200 with deny', async () => {
    const res = await request(app)
      .post(`/api/hooks/pre-tool-use?token=tok-gate&conversation_id=${convId}`)
      .send(bashBody('close-task', '--task abc'))
      .expect(200);

    expect(res.body.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('no conversation_id → allow (failsafe, no gate without context)', async () => {
    const res = await request(app)
      .post('/api/hooks/pre-tool-use?token=tok-gate')
      .send(bashBody('create-task'))
      .expect(200);

    expect(res.body.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
