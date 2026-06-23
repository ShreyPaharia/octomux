/**
 * server/orchestrator/mcp/verify.test.ts
 *
 * Tests for the verifier gate (Task 3.5 / SHR-134):
 *  - handleRequestReview surfaces verdict+tests pointers (never file contents).
 *  - Dependent task dispatches only after all dependencies are done.
 *  - A blocked (failed) dependency surfaces ONE consolidated card, not a cascade.
 *  - Loop-breaker caps: batch dispatch capped at MAX_BATCH_SIZE.
 *  - Usage guardrail: tasks_spawned/tool_calls soft threshold.
 *
 * Spec refs: §6.4 (verification gate), §9.1 (DAG scheduling), §10 (loop safety).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, insertTask } from '../../test-helpers.js';
import { getDb } from '../../db.js';
import {
  createConversation,
  upsertManagedTask,
  getManagedTask,
  incrementConversationUsage,
} from '../store.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('../stream.js', () => ({
  pushToConversation: vi.fn((_convId: string, msg: string) => mockPush(msg)),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
}));

vi.mock('../runner.js', () => ({
  startConversation: vi.fn().mockResolvedValue(undefined),
  resumeConversation: vi.fn().mockResolvedValue(undefined),
  sendTurn: vi.fn().mockResolvedValue(undefined),
  stopConversation: vi.fn().mockResolvedValue(undefined),
  conversationTmuxTarget: vi.fn().mockReturnValue('mock-session:1'),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  handleRequestReview,
  scheduleDagStep,
  checkUsageGuardrail,
  MAX_RESUME_ATTEMPTS,
  MAX_BATCH_SIZE,
  USAGE_TASKS_SOFT_LIMIT,
  USAGE_TOOL_CALLS_SOFT_LIMIT,
} from './verify.js';
import { pushToConversation } from '../stream.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(id: string) {
  const db = getDb();
  return insertTask(db, { id, worktree: null });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleRequestReview', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('returns verdict+tests as pointers, never file contents', async () => {
    const convId = createConversation({ title: 'Review Conv' });
    const task = makeTask('task-review-01');
    upsertManagedTask({
      conversation_id: convId,
      task_id: task.id,
      phase: 'done',
      artifacts: JSON.stringify({ diff_url: `/tasks/${task.id}?view=diff`, tests: 'passing' }),
    });

    const result = await handleRequestReview({ task_id: task.id, conversation_id: convId });

    // Returns pointers only: verdict URL and test status summary
    expect(result).toBeDefined();
    expect(result.review_pointer).toBeDefined();
    // Pointer is a URL/path, not file contents
    expect(typeof result.review_pointer).toBe('string');
    expect(result.review_pointer.length).toBeLessThan(512);
    // tests is a short status string, never the full test output
    expect(typeof result.tests_pointer).toBe('string');
    expect(result.tests_pointer.length).toBeLessThan(128);
    // No file body contents should appear
    expect(result.review_pointer).not.toContain('function ');
    expect(result.review_pointer).not.toContain('import ');
  });

  it('surfaces review link as a ws message pointing to the diff view', async () => {
    const convId = createConversation({ title: 'Review Card Conv' });
    const task = makeTask('task-review-02');
    upsertManagedTask({
      conversation_id: convId,
      task_id: task.id,
      phase: 'done',
      artifacts: JSON.stringify({ diff_url: `/tasks/${task.id}?view=diff` }),
    });

    await handleRequestReview({ task_id: task.id, conversation_id: convId });

    // Must push a ws event to the conversation
    expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
    const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const allParsed = calls.flatMap(([, msg]) => {
      try {
        return [JSON.parse(msg) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

    // One of the pushes must contain a review/diff pointer (never file contents)
    const reviewPush = allParsed.find((p) => {
      const text = String(p['text'] ?? JSON.stringify(p));
      return text.includes(task.id) || text.includes('review') || text.includes('diff');
    });
    expect(reviewPush).toBeDefined();
  });

  it('advances managed_tasks.phase to reviewing when review is requested', async () => {
    const convId = createConversation({ title: 'Phase Reviewing Conv' });
    const task = makeTask('task-review-03');
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'done' });

    await handleRequestReview({ task_id: task.id, conversation_id: convId });

    const mt = getManagedTask(task.id);
    expect(mt).toBeDefined();
    expect(mt!.phase).toBe('reviewing');
  });

  it('returns an empty tests pointer when no tests artifact is present', async () => {
    const convId = createConversation({ title: 'No Tests Conv' });
    const task = makeTask('task-review-04');
    upsertManagedTask({
      conversation_id: convId,
      task_id: task.id,
      phase: 'done',
      artifacts: JSON.stringify({ diff_url: `/tasks/${task.id}?view=diff` }),
    });

    const result = await handleRequestReview({ task_id: task.id, conversation_id: convId });
    // tests_pointer should be a string (may be empty), never throw
    expect(typeof result.tests_pointer).toBe('string');
  });

  it('throws when task_id has no managed_tasks row', async () => {
    const convId = createConversation({ title: 'No MT Conv' });
    makeTask('task-review-nomt');

    await expect(
      handleRequestReview({ task_id: 'task-review-nomt', conversation_id: convId }),
    ).rejects.toThrow(/not found|no managed/i);
  });
});

describe('DAG scheduling — scheduleDagStep', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('does not dispatch a task when its dependencies are not all done', async () => {
    const convId = createConversation({ title: 'DAG Wait Conv' });
    const dep = makeTask('task-dag-dep-01');
    const child = makeTask('task-dag-child-01');

    // dep is in 'implementing' phase (not done)
    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'implementing' });
    // child depends on dep
    upsertManagedTask({
      conversation_id: convId,
      task_id: child.id,
      phase: 'planning',
      depends_on: JSON.stringify([dep.id]),
    });

    const dispatched = await scheduleDagStep(convId, dep.id, 'implementing');
    expect(dispatched).toHaveLength(0);
  });

  it('dispatches a dependent task when all dependencies are done', async () => {
    const convId = createConversation({ title: 'DAG Ready Conv' });
    const dep = makeTask('task-dag-dep-02');
    const child = makeTask('task-dag-child-02');

    // dep is now done
    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'done' });
    // child depends on dep
    upsertManagedTask({
      conversation_id: convId,
      task_id: child.id,
      phase: 'planning',
      depends_on: JSON.stringify([dep.id]),
    });

    const dispatched = await scheduleDagStep(convId, dep.id, 'done');
    expect(dispatched).toContain(child.id);
  });

  it('dispatches child only when ALL dependencies are done (not just one)', async () => {
    const convId = createConversation({ title: 'DAG Multi Dep Conv' });
    const dep1 = makeTask('task-dag-dep1-03');
    const dep2 = makeTask('task-dag-dep2-03');
    const child = makeTask('task-dag-child-03');

    // dep1 done, dep2 NOT done
    upsertManagedTask({ conversation_id: convId, task_id: dep1.id, phase: 'done' });
    upsertManagedTask({ conversation_id: convId, task_id: dep2.id, phase: 'implementing' });
    upsertManagedTask({
      conversation_id: convId,
      task_id: child.id,
      phase: 'planning',
      depends_on: JSON.stringify([dep1.id, dep2.id]),
    });

    // dep1 finishes — child should NOT dispatch yet (dep2 still implementing)
    const dispatched = await scheduleDagStep(convId, dep1.id, 'done');
    expect(dispatched).not.toContain(child.id);

    // dep2 finishes — child SHOULD dispatch now
    upsertManagedTask({ conversation_id: convId, task_id: dep2.id, phase: 'done' });
    const dispatched2 = await scheduleDagStep(convId, dep2.id, 'done');
    expect(dispatched2).toContain(child.id);
  });

  it('marks dependents blocked when a dependency fails, surfacing ONE consolidated card', async () => {
    const convId = createConversation({ title: 'DAG Fail Conv' });
    const dep = makeTask('task-dag-dep-fail-01');
    const child1 = makeTask('task-dag-child-fail-01');
    const child2 = makeTask('task-dag-child-fail-02');

    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'implementing' });
    upsertManagedTask({
      conversation_id: convId,
      task_id: child1.id,
      phase: 'planning',
      depends_on: JSON.stringify([dep.id]),
    });
    upsertManagedTask({
      conversation_id: convId,
      task_id: child2.id,
      phase: 'planning',
      depends_on: JSON.stringify([dep.id]),
    });

    // dep fails
    const result = await scheduleDagStep(convId, dep.id, 'error');

    // Both children should be marked blocked
    expect(getManagedTask(child1.id)?.phase).toBe('blocked');
    expect(getManagedTask(child2.id)?.phase).toBe('blocked');

    // ONE consolidated card should be pushed (not two separate cards)
    const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const cardPushes = calls.filter(([, msg]) => {
      try {
        return (JSON.parse(msg) as { type?: string }).type === 'card';
      } catch {
        return false;
      }
    });
    expect(cardPushes).toHaveLength(1);

    // The consolidated card should list the blocked task ids
    const card = JSON.parse(cardPushes[0]![1]) as Record<string, unknown>;
    const cardStr = JSON.stringify(card);
    expect(cardStr).toContain(child1.id);
    expect(cardStr).toContain(child2.id);

    // No dispatched tasks on failure
    expect(result).toHaveLength(0);
  });

  it('returns empty when there are no dependent tasks', async () => {
    const convId = createConversation({ title: 'DAG No Children Conv' });
    const task = makeTask('task-dag-leaf-01');
    upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'done' });

    const dispatched = await scheduleDagStep(convId, task.id, 'done');
    expect(dispatched).toHaveLength(0);
  });
});

describe('loop-breaker caps', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('MAX_RESUME_ATTEMPTS is a positive number', () => {
    expect(typeof MAX_RESUME_ATTEMPTS).toBe('number');
    expect(MAX_RESUME_ATTEMPTS).toBeGreaterThan(0);
  });

  it('MAX_BATCH_SIZE is a positive number', () => {
    expect(typeof MAX_BATCH_SIZE).toBe('number');
    expect(MAX_BATCH_SIZE).toBeGreaterThan(0);
  });

  it('scheduleDagStep does not dispatch more than MAX_BATCH_SIZE tasks at once', async () => {
    const convId = createConversation({ title: 'Batch Cap Conv' });
    const dep = makeTask('task-batch-dep-01');
    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'implementing' });

    // Create MAX_BATCH_SIZE + 2 child tasks all depending on dep
    for (let i = 0; i < MAX_BATCH_SIZE + 2; i++) {
      const child = makeTask(`task-batch-child-${i.toString().padStart(3, '0')}`);
      upsertManagedTask({
        conversation_id: convId,
        task_id: child.id,
        phase: 'planning',
        depends_on: JSON.stringify([dep.id]),
      });
    }

    // Mark dep done — triggering dispatch of all children
    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'done' });
    const dispatched = await scheduleDagStep(convId, dep.id, 'done');

    // Must not exceed the batch cap
    expect(dispatched.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
  });

  it('halts and pushes a user-confirm note when batch cap is exceeded', async () => {
    const convId = createConversation({ title: 'Batch Halt Conv' });
    const dep = makeTask('task-batch-halt-dep');
    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'implementing' });

    for (let i = 0; i < MAX_BATCH_SIZE + 2; i++) {
      const child = makeTask(`task-batch-halt-child-${i.toString().padStart(3, '0')}`);
      upsertManagedTask({
        conversation_id: convId,
        task_id: child.id,
        phase: 'planning',
        depends_on: JSON.stringify([dep.id]),
      });
    }

    upsertManagedTask({ conversation_id: convId, task_id: dep.id, phase: 'done' });
    await scheduleDagStep(convId, dep.id, 'done');

    // A message must be pushed to the conversation alerting the user
    expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
    const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const msgs = calls.flatMap(([, msg]) => {
      try {
        return [JSON.parse(msg) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const haltMsg = msgs.find((m) => {
      const text = String(m['text'] ?? '');
      return (
        text.toLowerCase().includes('batch') ||
        text.toLowerCase().includes('cap') ||
        text.toLowerCase().includes('limit')
      );
    });
    expect(haltMsg).toBeDefined();
  });

  it('tracks managed_tasks.attempts correctly on upsert', () => {
    const convId = createConversation({ title: 'Attempts Conv' });
    const db = getDb();
    const task = insertTask(db, { id: 'task-attempts-01', worktree: null });
    upsertManagedTask({
      conversation_id: convId,
      task_id: task.id,
      phase: 'planning',
      attempts: 2,
    });

    const mt = getManagedTask(task.id);
    expect(mt!.attempts).toBe(2);

    // Bump attempts
    upsertManagedTask({ conversation_id: convId, task_id: task.id, attempts: 3 });
    const mt2 = getManagedTask(task.id);
    expect(mt2!.attempts).toBe(3);
  });
});

describe('usage guardrail', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('USAGE_TASKS_SOFT_LIMIT and USAGE_TOOL_CALLS_SOFT_LIMIT are positive numbers', () => {
    expect(typeof USAGE_TASKS_SOFT_LIMIT).toBe('number');
    expect(USAGE_TASKS_SOFT_LIMIT).toBeGreaterThan(0);
    expect(typeof USAGE_TOOL_CALLS_SOFT_LIMIT).toBe('number');
    expect(USAGE_TOOL_CALLS_SOFT_LIMIT).toBeGreaterThan(0);
  });

  // Note: incrementConversationUsage / getConversationUsage behavior is covered
  // directly in store.test.ts (they are store helpers). Here we only exercise
  // checkUsageGuardrail, using the store helper to set up usage state.

  it('checkUsageGuardrail returns {halted: false} below soft limits', () => {
    const convId = createConversation({ title: 'Usage Under Conv' });
    incrementConversationUsage(convId, { tasks_spawned: 1, tool_calls: 1 });
    const result = checkUsageGuardrail(convId);
    expect(result.halted).toBe(false);
  });

  it('checkUsageGuardrail returns {halted: true, reason} at or above tasks_spawned limit', () => {
    const convId = createConversation({ title: 'Usage Over Tasks Conv' });
    incrementConversationUsage(convId, { tasks_spawned: USAGE_TASKS_SOFT_LIMIT });
    const result = checkUsageGuardrail(convId);
    expect(result.halted).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });

  it('checkUsageGuardrail returns {halted: true, reason} at or above tool_calls limit', () => {
    const convId = createConversation({ title: 'Usage Over Calls Conv' });
    incrementConversationUsage(convId, { tool_calls: USAGE_TOOL_CALLS_SOFT_LIMIT });
    const result = checkUsageGuardrail(convId);
    expect(result.halted).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it('checkUsageGuardrail returns {halted: false} when conversation has no usage row', () => {
    const convId = createConversation({ title: 'No Usage Conv' });
    // No usage row created
    const result = checkUsageGuardrail(convId);
    expect(result.halted).toBe(false);
  });
});
