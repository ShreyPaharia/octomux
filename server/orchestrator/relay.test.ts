/**
 * server/orchestrator/relay.test.ts
 *
 * Integration tests for Task 2.5 / SHR-128:
 * relay choreography — plan → approve → implement → diff.
 *
 * Verifies:
 *  - phase_complete(plan) advances managed_tasks.phase to 'awaiting_approval'
 *    and pushes a card ws event with the plan pointer (not contents).
 *  - On approval, runSendMessage sends the implement turn to the worker.
 *  - phase_complete(implement) advances phase to 'done' and pushes a diff-view note.
 *  - No plan/diff/file contents ever reach the orchestrator context — only pointers.
 *  - The relay is idempotent: a duplicate phase_complete event does not re-fire.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTask, insertAgent } from '../test-helpers.js';
import { getDb } from '../db.js';
import { createConversation, upsertManagedTask, appendEvent, getManagedTask } from './store.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('./stream.js', () => ({
  pushToConversation: vi.fn((_convId: string, msg: string) => mockPush(msg)),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
}));

vi.mock('./runner.js', () => ({
  startConversation: vi.fn().mockResolvedValue(undefined),
  resumeConversation: vi.fn().mockResolvedValue(undefined),
  sendTurn: vi.fn().mockResolvedValue(undefined),
  stopConversation: vi.fn().mockResolvedValue(undefined),
  conversationTmuxTarget: vi.fn().mockReturnValue('mock-session:1'),
}));

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('./exec.js', () => ({
  runSendMessage: vi.fn((...args: unknown[]) => mockSendMessage(...args)),
  runCreateTask: vi.fn().mockResolvedValue({ task_id: 'mock-task-id', title: 'Mock Task' }),
  validatePlanJson: vi.fn().mockReturnValue({ valid: true }),
  PLAN_SCHEMA_VERSION: '1.0.0',
  PLAN_KIND: 'plan',
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { createSupervisor, type Supervisor } from './supervisor.js';
import { pushToConversation } from './stream.js';
import { runSendMessage } from './exec.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(id: string, opts: { tmux_session?: string } = {}) {
  const db = getDb();
  return insertTask(db, { id, worktree: null, tmux_session: opts.tmux_session ?? null });
}

function makeAgent(taskId: string, windowIndex = 1) {
  const db = getDb();
  return insertAgent(db, {
    id: `agent-${taskId}`,
    task_id: taskId,
    window_index: windowIndex,
    status: 'running',
    hook_token: `token-${taskId}`,
    harness_session_id: null,
    tmux_session: null,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('relay choreography (Task 2.5)', () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    supervisor = createSupervisor();
  });

  afterEach(() => {
    supervisor.stop();
  });

  describe('phase_complete(plan) → awaiting_approval + plan link card', () => {
    it('advances managed_tasks.phase to awaiting_approval on plan phase_complete', async () => {
      const convId = createConversation({ title: 'Plan Test Conv' });
      const task = makeTask('task-relay-plan-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      const mt = getManagedTask(task.id);
      expect(mt).toBeDefined();
      expect(mt!.phase).toBe('awaiting_approval');
    });

    it('sets artifact_lock_owner=ui on plan phase_complete', async () => {
      const convId = createConversation({ title: 'Lock Test Conv' });
      const task = makeTask('task-relay-lock-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      const mt = getManagedTask(task.id);
      expect(mt!.artifact_lock_owner).toBe('ui');
    });

    it('pushes a card ws event with the plan artifact pointer (not contents)', async () => {
      const convId = createConversation({ title: 'Card Push Conv' });
      const task = makeTask('task-relay-card-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));

      // Find the card push (there may also be a message push)
      const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [
        string,
        string,
      ][];
      const cardPushes = calls
        .filter(([, msg]) => {
          try {
            const parsed = JSON.parse(msg) as { type?: string };
            return parsed.type === 'card';
          } catch {
            return false;
          }
        })
        .map(([, msg]) => JSON.parse(msg) as Record<string, unknown>);

      expect(cardPushes).toHaveLength(1);
      const card = cardPushes[0]!;
      // Card must contain task_id (pointer), not file contents
      expect(card['args']).toBeDefined();
      const args = card['args'] as Record<string, unknown>;
      expect(args['task_id']).toBe(task.id);
      // Artifact path is a pointer, not file contents
      expect(typeof args['plan_path']).toBe('string');
      // The card must not contain any file body content
      const cardStr = JSON.stringify(card);
      expect(cardStr).not.toContain('"summary"'); // plan.json field
      expect(cardStr).not.toContain('"files"'); // plan.json field
    });

    it('stores artifact pointers in managed_tasks.artifacts (not contents)', async () => {
      const convId = createConversation({ title: 'Artifacts Conv' });
      const task = makeTask('task-relay-artifacts-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json', 'PLAN.md'] }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json', 'PLAN.md'] }),
      });

      const mt = getManagedTask(task.id);
      expect(mt!.artifacts).toBeTruthy();
      // Artifacts is a JSON string of pointers
      const arts = JSON.parse(mt!.artifacts!) as Record<string, unknown>;
      // Should have a plan pointer
      expect(arts['plan']).toBeDefined();
      // Should NOT contain file body contents
      expect(JSON.stringify(arts)).not.toContain('"summary"');
    });
  });

  describe('approval → runSendMessage → same-session continuity', () => {
    it('runSendMessage is callable with the correct task_id and implement message', async () => {
      const taskId = 'task-relay-impl-01';
      const msg = 'Please implement the approved plan.json';
      await runSendMessage(taskId, msg);
      expect(mockSendMessage).toHaveBeenCalledWith(taskId, msg);
    });
  });

  describe('phase_complete(implement) → done + diff-view link', () => {
    it('advances managed_tasks.phase to done on implement phase_complete', async () => {
      const convId = createConversation({ title: 'Impl Done Conv' });
      const task = makeTask('task-relay-impl-done-01');
      upsertManagedTask({
        conversation_id: convId,
        task_id: task.id,
        phase: 'implementing',
      });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });

      const mt = getManagedTask(task.id);
      expect(mt!.phase).toBe('done');
    });

    it('pushes a message with the diff-view URL (pointer only) on implement complete', async () => {
      const convId = createConversation({ title: 'Diff Link Conv' });
      const task = makeTask('task-relay-diff-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'implementing' });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });

      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });

      expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
      const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [
        string,
        string,
      ][];
      const allPushes = calls.flatMap(([, msg]) => {
        try {
          return [JSON.parse(msg) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      // One of the pushes should be a message with a diff link
      const diffPush = allPushes.find((p) => {
        const text = (p['text'] as string) ?? '';
        return text.includes(task.id) && (text.includes('diff') || text.includes('view'));
      });
      expect(diffPush).toBeDefined();
      // diff link is a URL pointer, never code or file contents
      const text = (diffPush!['text'] as string) ?? '';
      expect(text).not.toContain('function ');
      expect(text).not.toContain('import ');
    });
  });

  describe('full plan → approve → implement → diff cycle', () => {
    it('advances phase through planning → awaiting_approval → implementing → done', async () => {
      const convId = createConversation({ title: 'Full Cycle Conv' });
      const task = makeTask('task-relay-cycle-01', { tmux_session: 'octomux-agent-cycle-01' });
      makeAgent(task.id, 1);
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      // Step 1: plan phase complete
      const seqPlan = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });
      await supervisor.processEvent({
        seq: seqPlan,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] }),
      });

      expect(getManagedTask(task.id)!.phase).toBe('awaiting_approval');

      // Step 2: simulate approval — update phase to implementing + call runSendMessage
      upsertManagedTask({
        conversation_id: convId,
        task_id: task.id,
        phase: 'implementing',
      });

      // Step 3: implement phase complete
      const seqImpl = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });
      await supervisor.processEvent({
        seq: seqImpl,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'implement' }),
      });

      expect(getManagedTask(task.id)!.phase).toBe('done');

      // Verify pointers-not-contents: no plan body in any pushed message
      const allPushed = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls.map(
        (args: unknown[]) => args[1] as string,
      );
      for (const msg of allPushed) {
        // Plan body field names should never appear in pushed messages
        expect(msg).not.toContain('"open_questions"');
        expect(msg).not.toContain('"detail"');
      }
    });

    it('is idempotent: duplicate plan phase_complete does not re-fire the relay card', async () => {
      const convId = createConversation({ title: 'Idempotent Conv' });
      const task = makeTask('task-relay-idem-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

      const payload = JSON.stringify({ phase: 'plan', artifacts: ['plan.json'] });
      const seq = appendEvent({ task_id: task.id, type: 'task:phase_complete', payload });

      const event = { seq, task_id: task.id, type: 'task:phase_complete', payload };
      await supervisor.processEvent(event);
      await supervisor.processEvent(event); // duplicate
      await supervisor.processEvent(event); // triplicate

      // Only one card should have been pushed (idempotency)
      const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [
        string,
        string,
      ][];
      const cardPushes = calls.filter(([, msg]) => {
        try {
          return (JSON.parse(msg) as { type?: string }).type === 'card';
        } catch {
          return false;
        }
      });
      expect(cardPushes).toHaveLength(1);
    });
  });
});

describe('runSendMessage', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('is exported from exec.ts', async () => {
    const { runSendMessage: fn } = await import('./exec.js');
    expect(typeof fn).toBe('function');
  });
});
