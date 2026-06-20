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
import {
  createConversation,
  getCard,
  listPendingCards,
  createCard,
  resolveCard,
  upsertManagedTask,
  getManagedTask,
} from './store.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock exec so we don't need real task-runner / tmux
const mockRunCreateTask = vi.fn().mockResolvedValue({ task_id: 'new-task-id', title: 'Test Task' });
const mockRunSendMessage = vi.fn().mockResolvedValue(undefined);
const mockRunAddAgent = vi.fn().mockResolvedValue({ agent_id: 'new-agent-id', window_index: 1 });
const mockRunSetStatus = vi.fn().mockResolvedValue(undefined);
const mockRunCloseTask = vi.fn().mockResolvedValue(undefined);
const mockRunResumeTask = vi.fn().mockResolvedValue(undefined);
const mockRunDeleteTask = vi.fn().mockResolvedValue(undefined);

vi.mock('./exec.js', () => ({
  runCreateTask: vi.fn((...args: unknown[]) => mockRunCreateTask(...args)),
  runSendMessage: vi.fn((...args: unknown[]) => mockRunSendMessage(...args)),
  runAddAgent: vi.fn((...args: unknown[]) => mockRunAddAgent(...args)),
  runSetStatus: vi.fn((...args: unknown[]) => mockRunSetStatus(...args)),
  runCloseTask: vi.fn((...args: unknown[]) => mockRunCloseTask(...args)),
  runResumeTask: vi.fn((...args: unknown[]) => mockRunResumeTask(...args)),
  runDeleteTask: vi.fn((...args: unknown[]) => mockRunDeleteTask(...args)),
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

  it('non-octomux bash command → allow even WITH a conversation (gate scopes to octomux)', async () => {
    // The PreToolUse matcher catches ALL Bash, so cat/ls/grep reads reach the
    // gate. They must pass through untouched — only `octomux *` is gated.
    const reads = ['cat plan.json', 'ls -la', 'grep foo bar.txt', 'echo hi'];
    for (const command of reads) {
      const result = await handlePreToolUse({
        conversation_id: convId,
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: `tu-read-${command.slice(0, 3)}`,
      });
      expect(result.decision).toBe('allow');
      expect(result.card_id).toBeUndefined();
    }
    // No cards created for read passthrough.
    expect(listPendingCards(convId)).toHaveLength(0);
  });

  it('octomux write command WITH a conversation → deny + card (gate actually fires)', async () => {
    const result = await handlePreToolUse({
      conversation_id: convId,
      tool_name: 'Bash',
      tool_input: { command: 'octomux create-task --title "Gated" --description "x"' },
      tool_use_id: 'tu-gated',
    });
    expect(result.decision).toBe('deny');
    expect(result.card_id).toBeTruthy();
    expect(listPendingCards(convId)).toHaveLength(1);
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

// ─── Task 3.4: full write-command surface gating ──────────────────────────────

describe('gate: full write-command surface — tier classification (Task 3.4)', () => {
  let convId: string;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    convId = makeConversation();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['add-agent', 'send-message', 'set-status', 'request-review', 'resume-task'])(
    'ask-tier subcommand %s → deny + card',
    async (subcommand) => {
      const result = await handlePreToolUse({
        conversation_id: convId,
        tool_name: 'Bash',
        tool_input: { command: `octomux ${subcommand} --task abc123` },
        tool_use_id: `tu-tier-${subcommand}`,
      });

      expect(result.decision).toBe('deny');
      expect(result.card_id).toBeTruthy();
    },
  );

  it.each(['close-task', 'delete-task'])(
    'always-ask subcommand %s → deny + card (never auto-allowed)',
    async (subcommand) => {
      const result = await handlePreToolUse({
        conversation_id: convId,
        tool_name: 'Bash',
        tool_input: { command: `octomux ${subcommand} --task abc123` },
        tool_use_id: `tu-always-${subcommand}`,
      });

      expect(result.decision).toBe('deny');
      expect(result.card_id).toBeTruthy();
    },
  );
});

describe('gate.executeCard — new write commands (Task 3.4)', () => {
  let convId: string;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    convId = makeConversation();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function insertCard(subcommand: string, extraArgs = ''): string {
    const command = extraArgs
      ? `octomux ${subcommand} ${extraArgs}`
      : `octomux ${subcommand} --task abc123`;
    return createCard({
      conversation_id: convId,
      tool_use_id: `tu-exec-${subcommand}`,
      tool_name: 'Bash',
      input: JSON.stringify({ command }),
    });
  }

  it.each([
    ['add-agent', '--task t1 --prompt Focus-on-tests'],
    ['set-status', '--task t1 --status in_progress'],
    ['resume-task', '--task t1'],
  ])('Approve %s → runs op server-side + resolves to executed', async (subcommand, args) => {
    const cardId = insertCard(subcommand, args);

    await executeCard({ card_id: cardId, decision: 'approve' });

    const card = getCard(cardId)!;
    expect(card.status).toBe('executed');
    expect(mockPushToConversation).toHaveBeenCalled();
  });

  it.each([
    ['close-task', '--task t1'],
    ['delete-task', '--task t1'],
  ])(
    'Approve %s (always-ask) → runs op server-side + resolves to executed',
    async (subcommand, args) => {
      const cardId = insertCard(subcommand, args);

      await executeCard({ card_id: cardId, decision: 'approve' });

      const card = getCard(cardId)!;
      expect(card.status).toBe('executed');
      expect(mockPushToConversation).toHaveBeenCalled();
    },
  );

  it('add-agent: passes --prompt and --label to runAddAgent', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-add-agent-opts',
      tool_name: 'Bash',
      input: JSON.stringify({
        // parseCliArgs splits on whitespace; use single-token values
        command: 'octomux add-agent --task task-abc --prompt Fix-tests --label TestAgent',
      }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunAddAgent).toHaveBeenCalledWith(
      'task-abc',
      expect.objectContaining({ prompt: 'Fix-tests', label: 'TestAgent' }),
    );
  });

  it('set-status: passes taskId and status to runSetStatus', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-set-status',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux set-status --task task-xyz --status done' }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunSetStatus).toHaveBeenCalledWith('task-xyz', 'done');
  });

  it('close-task: passes taskId to runCloseTask', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-close-task',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux close-task --task task-abc' }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunCloseTask).toHaveBeenCalledWith('task-abc');
  });

  it('resume-task: passes taskId to runResumeTask', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-resume-task',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux resume-task --task task-abc' }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunResumeTask).toHaveBeenCalledWith('task-abc');
  });

  it('delete-task: passes taskId to runDeleteTask', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-delete-task',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux delete-task --task task-abc' }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunDeleteTask).toHaveBeenCalledWith('task-abc');
  });

  it('create-task with --model and --effort → model forwarded to runCreateTask', async () => {
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-create-rightsized',
      tool_name: 'Bash',
      input: JSON.stringify({
        command:
          'octomux create-task --title "Big refactor" --repo /tmp/repo --model claude-opus-4-5 --effort xhigh',
      }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    expect(mockRunCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-5', effort: 'xhigh' }),
    );
  });
});

// ─── approve-plan relay (the plan→implement handoff) ──────────────────────────
//
// Regression coverage for the dead relay: the supervisor mints an 'approve-plan'
// card on plan phase-complete, and approving it must send the worker an
// "implement" turn. Previously executeCard had no approve-plan branch, so
// approving the plan card was a silent no-op and the loop never advanced.
describe('gate.executeCard — approve-plan relay', () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it('approving a plan card sends the worker an implement turn and advances phase', async () => {
    const convId = createConversation({ title: 'Plan relay' });
    insertTask(db, { id: 'task-plan-1', title: 'Plan task' }); // satisfy managed_tasks FK
    upsertManagedTask({
      conversation_id: convId,
      task_id: 'task-plan-1',
      phase: 'awaiting_approval',
    });
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'relay-x',
      tool_name: 'approve-plan',
      input: JSON.stringify({ task_id: 'task-plan-1', plan_path: 'plan.json' }),
    });

    await executeCard({ card_id: cardId, decision: 'approve' });

    // The heart of the loop: the worker is told to implement.
    expect(mockRunSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRunSendMessage.mock.calls[0]![0]).toBe('task-plan-1');
    expect(String(mockRunSendMessage.mock.calls[0]![1])).toMatch(/implement/i);

    expect(getCard(cardId)!.status).toBe('executed');
    expect(getManagedTask('task-plan-1')!.phase).toBe('implementing');
  });

  it('rejecting a plan card does NOT send an implement turn', async () => {
    const convId = createConversation({ title: 'Plan reject' });
    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'relay-y',
      tool_name: 'approve-plan',
      input: JSON.stringify({ task_id: 'task-plan-2' }),
    });

    await executeCard({ card_id: cardId, decision: 'reject' });

    expect(mockRunSendMessage).not.toHaveBeenCalled();
    expect(getCard(cardId)!.status).toBe('rejected');
  });
});
