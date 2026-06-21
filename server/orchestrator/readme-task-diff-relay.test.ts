/**
 * server/orchestrator/readme-task-diff-relay.test.ts
 *
 * End-to-end (server-pipeline) regression test for the worker → orchestrator
 * done-signal (SHR-160 + the upsertManagedTask phase-clobber fix).
 *
 * Reproduces the exact reported symptom: "ask the orchestrator to create an
 * Update-README task — the task is created, but no update with a diff link ever
 * comes back."
 *
 * It drives the real server pipeline, wiring the in-process event bus to the
 * supervisor exactly like server/index.ts does:
 *
 *   conductor creates a plain implement task   → managed_tasks.phase = 'implementing'
 *   worker hook activity fires task:updated     → supervisor bumps last_event_seq
 *                                                 (NO phase)  ← the clobber trigger
 *   worker report_complete({phase:'implement'}) → advancePhaseForLabel('implement')
 *                                                 (guard: phase must be 'implementing')
 *   advancePhaseForLabel broadcasts             → task:phase_complete
 *   supervisor implement branch                 → pushes "diff view: /tasks/<id>?view=diff"
 *
 * Before the fix, the task:updated seq-bumps reset the phase back to 'planning',
 * so advancePhaseForLabel's guard no-op'd, no task:phase_complete was broadcast,
 * and the conversation never received the diff-link update — the bug. This test
 * asserts both that the task is tracked AND that the diff-link update is relayed.
 *
 * No browser and no real LLM/conductor: those make a CI-grade assertion
 * impossible. Everything below the conductor (the part that was broken) is real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';

// ─── Mocks: keep the supervisor off tmux/ws, capture conversation pushes ──────

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

vi.mock('./exec.js', () => ({
  runSendMessage: vi.fn().mockResolvedValue(undefined),
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

// Imported after the mocks. broadcast/events.js and hooks.js are intentionally
// REAL — they are the wiring that was broken.
import { createSupervisor, type Supervisor } from './supervisor.js';
import { createConversation, upsertManagedTask, getManagedTask } from './store.js';
import { advancePhaseForLabel } from '../hooks.js';
import { broadcast, subscribeServerEvents } from '../events.js';

describe('orchestrator: Update-README task → diff-link update relay', () => {
  let supervisor: Supervisor;
  let unsubscribe: () => void;
  // processEvent promises spawned by broadcasts, drained by settle().
  let pending: Promise<void>[];

  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    pending = [];
    supervisor = createSupervisor();
    // Wire the real in-process event bus to the supervisor — copied verbatim
    // from server/index.ts so the test exercises the production path.
    unsubscribe = subscribeServerEvents((event, seq) => {
      if (seq === undefined) return;
      const taskId = (event.payload as { taskId?: string }).taskId;
      if (!taskId) return;
      pending.push(
        supervisor.processEvent({
          seq,
          task_id: taskId,
          type: event.type,
          payload: JSON.stringify(event.payload),
        }),
      );
    });
  });

  afterEach(() => {
    unsubscribe();
    supervisor.stop();
  });

  /** Drain every processEvent promise triggered by broadcasts so far. */
  async function settle(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  }

  it('creates the task and relays an implementation-complete update carrying the diff link', async () => {
    const convId = createConversation({ title: 'Update README' });
    const db = getDb();
    const task = insertTask(db, {
      id: 'task-readme-relay',
      worktree: null,
      runtime_state: 'running',
    });

    // The conductor created a plain implement task → registered at 'implementing'.
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'implementing' });

    // ── 1. The task is created and tracked by its owning conversation ──────────
    const tracked = getManagedTask(task.id);
    expect(tracked).toBeDefined();
    expect(tracked!.conversation_id).toBe(convId);
    expect(tracked!.phase).toBe('implementing');

    // ── 2. Worker hook activity fires generic task:updated events. The supervisor
    //       bumps last_event_seq WITHOUT a phase — the exact action that used to
    //       clobber phase → 'planning' and silently break the relay. ────────────
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    await settle();

    // Regression guard: the phase must survive the seq bumps.
    expect(getManagedTask(task.id)!.phase).toBe('implementing');

    // ── 3. Worker calls report_complete({phase:'implement'}). The phase-complete
    //       handler runs advancePhaseForLabel, which (only if the guard still
    //       sees 'implementing') broadcasts task:phase_complete. ────────────────
    mockPush.mockClear();
    advancePhaseForLabel(task.id, 'implement');
    await settle();

    // ── 4. The orchestrator conversation receives an update, and it carries the
    //       diff-view link — this is the "update with diff link" that was missing.
    const pushed = mockPush.mock.calls.map((c) => String(c[0]));
    const diffUpdate = pushed.find((m) => m.includes(`/tasks/${task.id}?view=diff`));
    expect(
      diffUpdate,
      `no diff-link update was relayed to the conversation. pushed=${JSON.stringify(pushed)}`,
    ).toBeDefined();
    expect(diffUpdate).toContain('implementation complete');

    // ── 5. The task advances to done. ─────────────────────────────────────────
    expect(getManagedTask(task.id)!.phase).toBe('done');
  });

  it('documents the bug: a clobbered phase drops the report and no diff link comes back', async () => {
    const convId = createConversation({ title: 'Update README (clobbered)' });
    const db = getDb();
    const task = insertTask(db, {
      id: 'task-readme-clobbered',
      worktree: null,
      runtime_state: 'running',
    });

    // Simulate the post-clobber state the bug produced: phase stuck at 'planning'
    // even though the worker is actually implementing.
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'planning' });

    mockPush.mockClear();
    // Worker reports implement-complete, but the guard rejects it because the
    // phase is no longer 'implementing'.
    advancePhaseForLabel(task.id, 'implement');
    await settle();

    // No diff-link update reaches the conversation — exactly the reported failure.
    const pushed = mockPush.mock.calls.map((c) => String(c[0]));
    expect(pushed.some((m) => m.includes(`/tasks/${task.id}?view=diff`))).toBe(false);
    // And the task never advances to done.
    expect(getManagedTask(task.id)!.phase).toBe('planning');
  });
});
