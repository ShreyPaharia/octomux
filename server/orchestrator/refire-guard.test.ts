/**
 * server/orchestrator/refire-guard.test.ts
 *
 * Tests for the artifact/card-existence re-fire guard (hasAlreadyRelayed,
 * server/hooks.ts) that stands in for `managed_tasks.phase` in the Stop-hook
 * backstop (maybeSignalPhaseComplete). `spec.md` and `plan.json` are never
 * deleted, so once a later change removes the `phase` gate, the backstop
 * would otherwise re-detect them — and re-relay — on every subsequent Stop
 * hook for the rest of the task's life:
 *   - spec  → re-injects the "write plan.json" instruction into a live
 *             session mid-work (via the supervisor's runSendMessage).
 *   - plan  → mints a duplicate `approve-plan` card with no dedup key.
 *
 * These tests exercise the real HTTP hook endpoints (POST /stop and POST
 * /phase-complete) against a real app + DB, with the supervisor wired up
 * exactly as server/index.ts wires it (subscribeServerEvents →
 * supervisor.processEvent) so the full relay (runSendMessage / createCard)
 * is observable — not just the phase column advancing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, insertTask, insertAgent } from '../test-helpers.js';
import { createApp } from '../app.js';
import { subscribeServerEvents, type ServerEvent } from '../events.js';
import { createSupervisor, type Supervisor } from './supervisor.js';
import {
  createConversation,
  upsertManagedTask,
  getManagedTask,
  eventsSince,
  listPendingCards,
  createCard,
  resolveCard,
  appendEvent,
} from '../repositories/orchestrator.js';
import { hasAlreadyRelayed } from '../hooks.js';

// Capture runSendMessage calls from the supervisor's spec-relay branch.
const mockRunSendMessage = vi.fn().mockResolvedValue(undefined);
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

// Mock stream.ts so pushToConversation doesn't need a live ws client.
vi.mock('./stream.js', () => ({
  pushToConversation: vi.fn(),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
}));

describe('re-fire guard (hasAlreadyRelayed) — spec/plan relay does not double-fire', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;
  let worktreeDir: string;
  let supervisor: Supervisor;
  let unsubscribe: () => void;
  // Every broadcast synchronously kicks off supervisor.processEvent (via the
  // subscribeServerEvents listener below); collect the promises so tests can
  // await full relay completion before asserting.
  let pending: Promise<void>[];

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-refire-'));
    mockRunSendMessage.mockClear();

    // Wire the supervisor exactly as server/index.ts does, so the real relay
    // (runSendMessage / createCard) fires off the real broadcast() calls
    // inside advancePhaseForLabel.
    supervisor = createSupervisor();
    pending = [];
    unsubscribe = subscribeServerEvents((event: ServerEvent, seq: number | undefined) => {
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

  afterEach(async () => {
    await Promise.all(pending);
    unsubscribe();
    supervisor.stop();
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  /** Flush the supervisor's async relay work queued by the last request. */
  async function flush(): Promise<void> {
    await Promise.all(pending);
    pending = [];
  }

  function setup(taskId: string, phase: string, sessionId: string, hookToken: string): string {
    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      worktree: worktreeDir,
    });
    insertAgent(db, {
      id: `agent-${taskId}`,
      task_id: taskId,
      harness_session_id: sessionId,
      hook_token: hookToken,
    } as any);
    const convId = createConversation({ title: `conv-${taskId}` });
    upsertManagedTask({ conversation_id: convId, task_id: taskId, phase });
    return convId;
  }

  it('1. explicit report_complete(spec) then a same-task Stop hook with spec.md present → exactly ONE runSendMessage call and ONE task:phase_complete(spec) broadcast', async () => {
    const taskId = 'task-spec-explicit';
    const convId = setup(taskId, 'speccing', 'sess-1', 'tok-1');
    fs.writeFileSync(path.join(worktreeDir, 'spec.md'), '# Spec');

    // Explicit MCP report_complete('spec') → POST /phase-complete
    await request(app)
      .post(`/api/hooks/phase-complete?token=tok-1`)
      .send({ task_id: taskId, phase: 'spec', artifacts: ['spec.md'] })
      .expect(200);
    await flush();

    // Same-task Stop hook backstop fires afterwards — phase already advanced
    // to 'planning', spec.md still present on disk (never deleted).
    await request(app)
      .post('/api/hooks/stop?token=tok-1')
      .send({ session_id: 'sess-1' })
      .expect(200);
    await flush();

    expect(mockRunSendMessage).toHaveBeenCalledTimes(1);
    const specEvents = eventsSince(0).filter((e) => {
      if (e.type !== 'task:phase_complete') return false;
      return (JSON.parse(e.payload) as { phase?: string }).phase === 'spec';
    });
    expect(specEvents).toHaveLength(1);
    expect(getManagedTask(taskId)!.phase).toBe('planning');
    void convId;
  });

  it('2. explicit report_complete(plan) then a same-task Stop hook with plan.json present → exactly ONE approve-plan card minted', async () => {
    const taskId = 'task-plan-explicit';
    const convId = setup(taskId, 'planning', 'sess-2', 'tok-2');
    fs.writeFileSync(path.join(worktreeDir, 'plan.json'), '{"schema_version":"1.0.0"}');

    await request(app)
      .post(`/api/hooks/phase-complete?token=tok-2`)
      .send({ task_id: taskId, phase: 'plan', artifacts: ['plan.json'] })
      .expect(200);
    await flush();

    await request(app)
      .post('/api/hooks/stop?token=tok-2')
      .send({ session_id: 'sess-2' })
      .expect(200);
    await flush();

    const cards = listPendingCards(convId).filter((c) => c.tool_name === 'approve-plan');
    expect(cards).toHaveLength(1);
    expect(getManagedTask(taskId)!.phase).toBe('awaiting_approval');
  });

  it('3. a THIRD, later Stop hook (during implementation) does not re-fire the spec or plan relay', async () => {
    const taskId = 'task-third-stop';
    setup(taskId, 'speccing', 'sess-3', 'tok-3');
    fs.writeFileSync(path.join(worktreeDir, 'spec.md'), '# Spec');

    // Turn 1: spec relays (spec.md present, phase speccing → planning).
    await request(app)
      .post('/api/hooks/stop?token=tok-3')
      .send({ session_id: 'sess-3' })
      .expect(200);
    await flush();
    expect(mockRunSendMessage).toHaveBeenCalledTimes(1);

    // Turn 2: plan relays (worker wrote plan.json, phase planning → awaiting_approval).
    fs.writeFileSync(path.join(worktreeDir, 'plan.json'), '{"schema_version":"1.0.0"}');
    await request(app)
      .post('/api/hooks/stop?token=tok-3')
      .send({ session_id: 'sess-3' })
      .expect(200);
    await flush();

    const convId = getManagedTask(taskId)!.conversation_id;
    expect(listPendingCards(convId).filter((c) => c.tool_name === 'approve-plan')).toHaveLength(1);

    // Advance to implementing by hand (approval + implement kickoff aren't
    // this test's concern) — spec.md and plan.json remain on disk throughout.
    upsertManagedTask({ conversation_id: convId, task_id: taskId, phase: 'implementing' });

    // Turn 3, well after spec/plan relayed: neither marker was deleted, so
    // without the guard this Stop hook would re-detect both and re-relay.
    await request(app)
      .post('/api/hooks/stop?token=tok-3')
      .send({ session_id: 'sess-3' })
      .expect(200);
    await flush();

    expect(mockRunSendMessage).toHaveBeenCalledTimes(1); // still just the one from turn 1
    expect(listPendingCards(convId).filter((c) => c.tool_name === 'approve-plan')).toHaveLength(1);
    const specEvents = eventsSince(0).filter((e) => {
      if (e.type !== 'task:phase_complete') return false;
      return (JSON.parse(e.payload) as { phase?: string }).phase === 'spec';
    });
    const planEvents = eventsSince(0).filter((e) => {
      if (e.type !== 'task:phase_complete') return false;
      return (JSON.parse(e.payload) as { phase?: string }).phase === 'plan';
    });
    expect(specEvents).toHaveLength(1);
    expect(planEvents).toHaveLength(1);
  });
});

// ─── hasAlreadyRelayed — the guard in isolation, independent of any phase gate ──
//
// The tests above still pass today purely because maybeSignalPhaseComplete's
// `managed.phase === 'speccing'/'planning'` checks skip the marker check
// entirely once phase has moved on — the guard is never even reached. That
// proves nothing about the guard itself. These tests call hasAlreadyRelayed
// directly, with no phase gate in the picture at all, so they demonstrate the
// predicate carries the weight on its own — exactly the shape it will be
// relied on for once managed_tasks.phase is deleted.
describe('hasAlreadyRelayed — guard predicate in isolation (no phase gate involved)', () => {
  let db: Database.Database;
  let worktreeDir: string;

  beforeEach(() => {
    db = createTestDb();
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-refire-unit-'));
  });

  afterEach(() => {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  it("label 'spec': false until a spec phase_complete event exists, true after", () => {
    // Deliberately NOT keyed on plan.json's existence. Between the spec relay
    // and the worker actually writing plan.json there is a window — often many
    // turns — where the file is absent. A file-existence guard reports "not yet
    // relayed" for that whole window, which is precisely when the backstop
    // fires, so it would re-relay exactly when it must not. The durable event
    // row is written the instant the relay happens and never removed.
    const taskId = 'task-guard-spec';
    insertTask(db, { id: taskId, worktree: worktreeDir });

    expect(hasAlreadyRelayed(taskId, 'spec')).toBe(false);

    // plan.json appearing is NOT what makes the guard true.
    fs.writeFileSync(path.join(worktreeDir, 'plan.json'), '{}');
    expect(hasAlreadyRelayed(taskId, 'spec')).toBe(false);

    appendEvent({
      task_id: taskId,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'spec' }),
    });
    expect(hasAlreadyRelayed(taskId, 'spec')).toBe(true);
  });

  it("label 'spec': a phase_complete event for a DIFFERENT label does not count", () => {
    const taskId = 'task-guard-spec-other-label';
    insertTask(db, { id: taskId, worktree: worktreeDir });

    appendEvent({
      task_id: taskId,
      type: 'task:phase_complete',
      payload: JSON.stringify({ phase: 'implement' }),
    });
    expect(hasAlreadyRelayed(taskId, 'spec')).toBe(false);
  });

  it("label 'plan': false with no approve-plan card, true once a PENDING card exists", () => {
    const taskId = 'task-guard-plan-pending';
    insertTask(db, { id: taskId, worktree: worktreeDir });
    const convId = createConversation({ title: 'conv-guard-plan' });
    upsertManagedTask({ conversation_id: convId, task_id: taskId, phase: 'awaiting_approval' });

    expect(hasAlreadyRelayed(taskId, 'plan')).toBe(false);

    createCard({
      conversation_id: convId,
      tool_use_id: 'relay-guard-1',
      tool_name: 'approve-plan',
      input: JSON.stringify({ task_id: taskId, plan_path: 'plan.json' }),
    });
    expect(hasAlreadyRelayed(taskId, 'plan')).toBe(true);
  });

  it("label 'plan': stays true after the card is RESOLVED (approved) — a decided card still proves the relay happened", () => {
    const taskId = 'task-guard-plan-resolved';
    insertTask(db, { id: taskId, worktree: worktreeDir });
    const convId = createConversation({ title: 'conv-guard-plan-resolved' });
    upsertManagedTask({ conversation_id: convId, task_id: taskId, phase: 'implementing' });

    const cardId = createCard({
      conversation_id: convId,
      tool_use_id: 'relay-guard-2',
      tool_name: 'approve-plan',
      input: JSON.stringify({ task_id: taskId, plan_path: 'plan.json' }),
    });
    resolveCard(cardId, 'approved', null);

    expect(hasAlreadyRelayed(taskId, 'plan')).toBe(true);
  });

  it("label 'plan': a card for a DIFFERENT task in the same conversation does not count", () => {
    const taskId = 'task-guard-plan-scoped-a';
    const otherTaskId = 'task-guard-plan-scoped-b';
    insertTask(db, { id: taskId, worktree: worktreeDir });
    insertTask(db, { id: otherTaskId, worktree: worktreeDir });
    const convId = createConversation({ title: 'conv-guard-plan-scoped' });
    upsertManagedTask({ conversation_id: convId, task_id: taskId, phase: 'planning' });
    upsertManagedTask({
      conversation_id: convId,
      task_id: otherTaskId,
      phase: 'awaiting_approval',
    });

    createCard({
      conversation_id: convId,
      tool_use_id: 'relay-guard-3',
      tool_name: 'approve-plan',
      input: JSON.stringify({ task_id: otherTaskId, plan_path: 'plan.json' }),
    });

    expect(hasAlreadyRelayed(taskId, 'plan')).toBe(false);
    expect(hasAlreadyRelayed(otherTaskId, 'plan')).toBe(true);
  });

  it("label 'plan': false when the task has no owning conversation (unmanaged)", () => {
    const taskId = 'task-guard-plan-unmanaged';
    insertTask(db, { id: taskId, worktree: worktreeDir });
    // No managed_tasks row → findConversationForTask returns null.
    expect(hasAlreadyRelayed(taskId, 'plan')).toBe(false);
  });
});
