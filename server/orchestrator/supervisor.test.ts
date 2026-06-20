/**
 * server/orchestrator/supervisor.test.ts
 *
 * Tests for the supervisor (Task 2.2 / SHR-125):
 *  - Routes events only to the conversation that owns the task via managed_tasks.
 *  - Duplicate event_seq does not double-inject.
 *  - Restart replays missed events (eventsSince(last_event_seq)).
 *  - Unowned tasks are dropped (unless global-monitor mode — Phase 5).
 *  - Serialized per-conversation queue (notes never interleave).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import { createConversation, upsertManagedTask, appendEvent, getManagedTask } from './store.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock stream.ts pushToConversation so we can capture injected notes without ws
const mockPush = vi.fn();
vi.mock('./stream.js', () => ({
  pushToConversation: vi.fn((_convId: string, msg: string) => mockPush(msg)),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
}));

// Mock runner to avoid tmux
vi.mock('./runner.js', () => ({
  startConversation: vi.fn().mockResolvedValue(undefined),
  resumeConversation: vi.fn().mockResolvedValue(undefined),
  sendTurn: vi.fn().mockResolvedValue(undefined),
  stopConversation: vi.fn().mockResolvedValue(undefined),
  conversationTmuxTarget: vi.fn().mockReturnValue('mock-session:1'),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

// Import supervisor after mocks are set up
import { createSupervisor, type Supervisor, type SupervisorInjection } from './supervisor.js';
import { pushToConversation } from './stream.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(id: string) {
  const db = getDb();
  return insertTask(db, { id, worktree: null });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('supervisor', () => {
  let supervisor: Supervisor;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    supervisor = createSupervisor();
  });

  afterEach(() => {
    supervisor.stop();
  });

  describe('routing — events route to owning conversation only', () => {
    it('routes a task:updated event to the conversation that owns the task', async () => {
      const convId = createConversation({ title: 'Conv A' });
      const task = makeTask('task-route-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({ seq, task_id: task.id, type: 'task:updated', payload: '{}' });

      expect(injections).toHaveLength(1);
      expect(injections[0]!.conversation_id).toBe(convId);
      expect(injections[0]!.task_id).toBe(task.id);
    });

    it('drops events for tasks not in managed_tasks', async () => {
      // task-unowned is NOT registered in managed_tasks
      makeTask('task-unowned-01');
      const seq = appendEvent({ task_id: 'task-unowned-01', type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: 'task-unowned-01',
        type: 'task:updated',
        payload: '{}',
      });

      expect(injections).toHaveLength(0);
    });

    it('routes events for different tasks to their respective conversations', async () => {
      const convA = createConversation({ title: 'Conv A' });
      const convB = createConversation({ title: 'Conv B' });
      const taskA = makeTask('task-multi-a');
      const taskB = makeTask('task-multi-b');
      upsertManagedTask({ conversation_id: convA, task_id: taskA.id });
      upsertManagedTask({ conversation_id: convB, task_id: taskB.id });

      const seqA = appendEvent({ task_id: taskA.id, type: 'task:updated', payload: '{}' });
      const seqB = appendEvent({
        task_id: taskB.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));

      await supervisor.processEvent({
        seq: seqA,
        task_id: taskA.id,
        type: 'task:updated',
        payload: '{}',
      });
      await supervisor.processEvent({
        seq: seqB,
        task_id: taskB.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      const forA = injections.filter((i) => i.conversation_id === convA);
      const forB = injections.filter((i) => i.conversation_id === convB);
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
    });
  });

  describe('idempotency — duplicate event_seq does not double-inject', () => {
    it('does not inject the same (task_id, seq) twice', async () => {
      const convId = createConversation({ title: 'Conv Dedup' });
      const task = makeTask('task-dedup-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));

      const eventData = { seq, task_id: task.id, type: 'task:updated', payload: '{}' };
      await supervisor.processEvent(eventData);
      await supervisor.processEvent(eventData); // duplicate
      await supervisor.processEvent(eventData); // triplicate

      expect(injections).toHaveLength(1);
    });

    it('accepts distinct seqs for the same task_id', async () => {
      const convId = createConversation({ title: 'Conv Multi-Seq' });
      const task = makeTask('task-multiseq-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq1 = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });
      const seq2 = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));

      await supervisor.processEvent({
        seq: seq1,
        task_id: task.id,
        type: 'task:updated',
        payload: '{}',
      });
      await supervisor.processEvent({
        seq: seq2,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      expect(injections).toHaveLength(2);
    });
  });

  describe('replay — eventsSince(last_event_seq) on connect', () => {
    it('replays events with seq > managed_tasks.last_event_seq on start', async () => {
      const convId = createConversation({ title: 'Conv Replay' });
      const task = makeTask('task-replay-01');
      // Simulate: task was registered before 2 events; last_event_seq is set to first event
      const seq1 = appendEvent({
        task_id: task.id,
        type: 'task:updated',
        payload: '{"first":true}',
      });
      upsertManagedTask({ conversation_id: convId, task_id: task.id, last_event_seq: seq1 });
      // A second event happened while the supervisor was offline
      const seq2 = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));

      // replay should inject events where seq > last_event_seq (seq1)
      await supervisor.replay(convId);

      expect(injections.some((i) => i.seq === seq2)).toBe(true);
      // seq1 should NOT be replayed (already processed)
      expect(injections.some((i) => i.seq === seq1)).toBe(false);
    });

    it('replays nothing when last_event_seq is at latest', async () => {
      const convId = createConversation({ title: 'Conv No-Replay' });
      const task = makeTask('task-noreplay-01');
      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });
      // last_event_seq is already at the latest event
      upsertManagedTask({ conversation_id: convId, task_id: task.id, last_event_seq: seq });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.replay(convId);

      expect(injections).toHaveLength(0);
    });

    it('updates last_event_seq after processing an event', async () => {
      const convId = createConversation({ title: 'Conv Track Seq' });
      const task = makeTask('task-trackseq-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });
      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      const mt = getManagedTask(task.id);
      expect(mt!.last_event_seq).toBe(seq);
    });
  });

  describe('injection content — concise notes only', () => {
    it('injects a concise note for task:updated', async () => {
      const convId = createConversation({ title: 'Conv Note' });
      const task = makeTask('task-note-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });
      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({ seq, task_id: task.id, type: 'task:updated', payload: '{}' });

      expect(injections[0]!.note).toBeTruthy();
      expect(typeof injections[0]!.note).toBe('string');
      // Note must be concise — no raw event firehose
      expect(injections[0]!.note.length).toBeLessThan(300);
    });

    it('injects a concise note for task:phase_complete', async () => {
      const convId = createConversation({ title: 'Conv Phase Note' });
      const task = makeTask('task-phase-note-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });
      const seq = appendEvent({
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'planning', taskId: task.id }),
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:phase_complete',
        payload: JSON.stringify({ phase: 'planning', taskId: task.id }),
      });

      const note = injections[0]!.note;
      expect(note).toContain(task.id);
      expect(note.toLowerCase()).toMatch(/plan|phase/);
    });

    it('injects a concise note for task:stuck', async () => {
      const convId = createConversation({ title: 'Conv Stuck Note' });
      const task = makeTask('task-stuck-note-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });
      const seq = appendEvent({
        task_id: task.id,
        type: 'task:stuck',
        payload: JSON.stringify({ reason: 'inactive', taskId: task.id }),
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:stuck',
        payload: JSON.stringify({ reason: 'inactive', taskId: task.id }),
      });

      const note = injections[0]!.note;
      expect(note).toContain(task.id);
      expect(note.toLowerCase()).toMatch(/stuck|inactive/);
    });
  });

  describe('pushToConversation integration', () => {
    it('calls pushToConversation with the conversation id and serialized note', async () => {
      const convId = createConversation({ title: 'Conv Push' });
      const task = makeTask('task-push-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });
      await supervisor.processEvent({ seq, task_id: task.id, type: 'task:updated', payload: '{}' });

      expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
    });
  });
});
