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
import {
  createConversation,
  upsertManagedTask,
  appendEvent,
  getManagedTask,
  setGlobalMonitor,
  clearGlobalMonitor,
  getGlobalMonitorConversation,
} from './store.js';

// We need to capture runSendMessage calls from supervisor's spec branch
const mockRunSendMessage = vi.fn().mockResolvedValue(undefined);

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

// Mock exec.js so the supervisor's runSendMessage doesn't need real tmux
vi.mock('./exec.js', () => ({
  runSendMessage: vi.fn((...args: unknown[]) => mockRunSendMessage(...args)),
  runCreateTask: vi.fn().mockResolvedValue({ task_id: 'mock', title: 'mock' }),
  runAddAgent: vi.fn().mockResolvedValue({ agent_id: 'mock', window_index: 1 }),
  runSetStatus: vi.fn().mockResolvedValue(undefined),
  runCloseTask: vi.fn().mockResolvedValue(undefined),
  runResumeTask: vi.fn().mockResolvedValue(undefined),
  runDeleteTask: vi.fn().mockResolvedValue(undefined),
  validatePlanJson: vi.fn().mockReturnValue({ valid: true }),
  PLAN_SCHEMA_VERSION: '1.0.0',
  PLAN_KIND: 'plan',
  WORKFLOW_KIND: 'workflow',
  buildWorkflowTemplate: vi.fn().mockReturnValue('workflow template'),
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

    it('relays a task error to the conversation once (not silently)', async () => {
      const convId = createConversation({ title: 'Conv err' });
      const db = getDb();
      insertTask(db, {
        id: 'task-err-01',
        worktree: null,
        runtime_state: 'error',
        error: 'Repository path does not exist: null',
      });
      upsertManagedTask({ conversation_id: convId, task_id: 'task-err-01' });

      const seq1 = appendEvent({ task_id: 'task-err-01', type: 'task:updated', payload: '{}' });
      await supervisor.processEvent({
        seq: seq1,
        task_id: 'task-err-01',
        type: 'task:updated',
        payload: '{}',
      });

      // The failure is surfaced with its error message.
      const errMsg = mockPush.mock.calls.map((c) => String(c[0])).find((m) => /failed/i.test(m));
      expect(errMsg).toBeDefined();
      expect(errMsg).toContain('task-err-01');
      expect(errMsg).toContain('Repository path does not exist');

      // A second task:updated must NOT re-notify the same error.
      mockPush.mockClear();
      const seq2 = appendEvent({ task_id: 'task-err-01', type: 'task:updated', payload: '{}' });
      await supervisor.processEvent({
        seq: seq2,
        task_id: 'task-err-01',
        type: 'task:updated',
        payload: '{}',
      });
      const reNotified = mockPush.mock.calls
        .map((c) => String(c[0]))
        .some((m) => /failed/i.test(m));
      expect(reNotified).toBe(false);
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
    it('relays a meaningful event (stuck) to pushToConversation', async () => {
      const convId = createConversation({ title: 'Conv Push' });
      const task = makeTask('task-push-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      const seq = appendEvent({
        task_id: task.id,
        type: 'task:stuck',
        payload: '{"reason":"no activity"}',
      });
      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:stuck',
        payload: '{"reason":"no activity"}',
      });

      expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
    });

    it('does NOT push a chat note for generic task:updated (no spam)', async () => {
      const convId = createConversation({ title: 'Conv NoSpam' });
      const task = makeTask('task-nospam-01');
      upsertManagedTask({ conversation_id: convId, task_id: task.id });

      // Several generic updates (as worker hooks fire) must not each become a note.
      for (let i = 0; i < 5; i++) {
        const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });
        await supervisor.processEvent({
          seq,
          task_id: task.id,
          type: 'task:updated',
          payload: '{}',
        });
      }

      expect(pushToConversation).not.toHaveBeenCalled();
    });
  });

  describe('global-monitor mode (Phase 5 / SHR-136)', () => {
    it('routes unowned task events to the global-monitor conversation as read-only notices', async () => {
      const monitorConvId = createConversation({ title: 'Global Monitor' });
      setGlobalMonitor(monitorConvId);
      // task not in managed_tasks (unowned)
      makeTask('task-gm-01');
      const seq = appendEvent({ task_id: 'task-gm-01', type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: 'task-gm-01',
        type: 'task:updated',
        payload: '{}',
      });

      // The global-monitor conversation should receive the event
      expect(injections).toHaveLength(1);
      expect(injections[0]!.conversation_id).toBe(monitorConvId);
    });

    it('marks global-monitor injections with read-only prefix', async () => {
      const monitorConvId = createConversation({ title: 'Global Monitor Read-Only' });
      setGlobalMonitor(monitorConvId);
      makeTask('task-gm-readonly-01');
      const seq = appendEvent({
        task_id: 'task-gm-readonly-01',
        type: 'task:stuck',
        payload: '{"reason":"inactive"}',
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: 'task-gm-readonly-01',
        type: 'task:stuck',
        payload: '{"reason":"inactive"}',
      });

      // The note must indicate read-only (monitor) status
      expect(injections[0]!.note).toMatch(/\[monitor\]/);
    });

    it('does NOT route to global-monitor if the task is already owned by a conversation', async () => {
      const ownerConvId = createConversation({ title: 'Owner Conv' });
      const monitorConvId = createConversation({ title: 'Monitor Conv' });
      setGlobalMonitor(monitorConvId);
      const task = makeTask('task-gm-owned-01');
      upsertManagedTask({ conversation_id: ownerConvId, task_id: task.id });

      const seq = appendEvent({ task_id: task.id, type: 'task:updated', payload: '{}' });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: task.id,
        type: 'task:updated',
        payload: '{}',
      });

      // Only the owner gets the event, not the monitor
      expect(injections).toHaveLength(1);
      expect(injections[0]!.conversation_id).toBe(ownerConvId);
    });

    it('drops events when no global-monitor is set and task is unowned', async () => {
      // No global monitor set
      makeTask('task-gm-dropped-01');
      const seq = appendEvent({
        task_id: 'task-gm-dropped-01',
        type: 'task:updated',
        payload: '{}',
      });

      const injections: SupervisorInjection[] = [];
      supervisor.on('inject', (inj) => injections.push(inj));
      await supervisor.processEvent({
        seq,
        task_id: 'task-gm-dropped-01',
        type: 'task:updated',
        payload: '{}',
      });

      expect(injections).toHaveLength(0);
    });

    it('only one conversation can be global-monitor at a time', () => {
      const conv1 = createConversation({ title: 'Monitor 1' });
      const conv2 = createConversation({ title: 'Monitor 2' });
      setGlobalMonitor(conv1);
      setGlobalMonitor(conv2); // overrides conv1

      const monitor = getGlobalMonitorConversation();
      expect(monitor).toBe(conv2);
    });

    it('clearGlobalMonitor removes global-monitor designation', () => {
      const convId = createConversation({ title: 'Monitor To Clear' });
      setGlobalMonitor(convId);
      clearGlobalMonitor();
      const monitor = getGlobalMonitorConversation();
      expect(monitor).toBeNull();
    });
  });
});

// ─── Supervisor spec branch (SHR-143) ─────────────────────────────────────────

describe('supervisor spec branch — phase:spec relay', () => {
  let supervisor: ReturnType<typeof createSupervisor>;

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    supervisor = createSupervisor();
  });

  afterEach(() => {
    supervisor.stop();
    vi.clearAllMocks();
  });

  it('phase=spec → pushes a view-spec card event (read-only, no action_cards row)', async () => {
    const convId = createConversation({ title: 'Spec conv' });
    const task = insertTask(getDb(), { id: 'task-spec-sup-01', worktree: null });
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'speccing' });

    const seq = appendEvent({
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    await supervisor.processEvent({
      seq,
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    // The supervisor must have pushed at least one message to the conversation
    expect(mockPush).toHaveBeenCalled();

    // Find the spec card event
    const pushed = mockPush.mock.calls.map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    const cardEvent = pushed.find((p) => p && p['type'] === 'card');
    expect(cardEvent).toBeDefined();
    expect(cardEvent!['command']).toBe('view-spec');
    expect((cardEvent!['args'] as Record<string, unknown>)['spec_path']).toBe('spec.md');
    expect((cardEvent!['args'] as Record<string, unknown>)['artifact_url']).toContain('spec.md');
  });

  it('phase=spec → no action_cards row created (read-only card)', async () => {
    const convId = createConversation({ title: 'Spec conv 2' });
    const task = insertTask(getDb(), { id: 'task-spec-sup-02', worktree: null });
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'speccing' });

    const seq = appendEvent({
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    await supervisor.processEvent({
      seq,
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    // No action_cards row should be created (read-only)
    const cards = getDb()
      .prepare(`SELECT * FROM action_cards WHERE conversation_id = ?`)
      .all(convId) as unknown[];
    expect(cards).toHaveLength(0);
  });

  it('phase=spec → calls runSendMessage to auto-advance worker to planning', async () => {
    const convId = createConversation({ title: 'Spec auto-advance conv' });
    const task = insertTask(getDb(), { id: 'task-spec-sup-03', worktree: null });
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'speccing' });

    const seq = appendEvent({
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    await supervisor.processEvent({
      seq,
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    // Wait for the fire-and-forget runSendMessage to resolve
    await vi.runAllTimersAsync().catch(() => {});
    // Give any pending microtasks a chance to run
    await Promise.resolve();

    expect(mockRunSendMessage).toHaveBeenCalledWith(
      task.id,
      expect.stringMatching(/spec.*review.*plan\.json/i),
    );
  });

  it('phase=spec → also pushes a concise assistant note', async () => {
    const convId = createConversation({ title: 'Spec note conv' });
    const task = insertTask(getDb(), { id: 'task-spec-sup-04', worktree: null });
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'speccing' });

    const seq = appendEvent({
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    await supervisor.processEvent({
      seq,
      task_id: task.id,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec', artifacts: ['spec.md'] }),
    });

    const messages = mockPush.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p) => p && p['type'] === 'message');
    expect(messages.length).toBeGreaterThan(0);
    const note = messages.find(
      (m) => typeof m!['text'] === 'string' && (m!['text'] as string).includes('spec'),
    );
    expect(note).toBeDefined();
  });

  it('phase=plan still pushes an approve-plan card (existing behavior unchanged)', async () => {
    const convId = createConversation({ title: 'Plan conv sup' });
    const task = insertTask(getDb(), { id: 'task-plan-sup-01', worktree: null });
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

    const pushed = mockPush.mock.calls.map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    const planCard = pushed.find(
      (p) => p && p['type'] === 'card' && p['command'] === 'approve-plan',
    );
    expect(planCard).toBeDefined();

    // action_cards row should exist for plan (requires user decision)
    const cards = getDb()
      .prepare(`SELECT * FROM action_cards WHERE conversation_id = ?`)
      .all(convId) as Array<{ tool_name: string }>;
    expect(cards.some((c) => c.tool_name === 'approve-plan')).toBe(true);
  });
});
