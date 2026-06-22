/**
 * server/orchestrator/mcp/verify.ts
 *
 * Verifier gate + DAG scheduling + loop-breakers (Task 3.5 / SHR-134).
 *
 * Components (spec §6.4, §9.1, §10):
 *
 * 1. handleRequestReview — `request_review(task_id)` routes a completed task
 *    through the reviewer and surfaces the review verdict + test/CI result as
 *    POINTERS only (diff_url, tests status string). The orchestrator holds the
 *    pointer; contents are fetched browser-side by the UI.
 *
 * 2. scheduleDagStep — supervisor calls this on every task phase transition.
 *    Walks `managed_tasks.depends_on` for the owning conversation to determine
 *    whether dependent tasks should now dispatch. Rules (spec §9.1):
 *      - Dispatch: all deps are 'done' → mark child 'planning' (signal readiness).
 *      - Failure cascade: dep is 'error'/'blocked' → mark all dependents 'blocked'
 *        and surface ONE consolidated card to the user (not per-child cards).
 *      - Batch cap: at most MAX_BATCH_SIZE tasks dispatched per step; if exceeded,
 *        pushes a confirm note and returns only the capped set.
 *      - Non-'done' phase → no dispatch (normal wait).
 *
 * 3. Usage guardrail helpers — incrementConversationUsage / getConversationUsage /
 *    checkUsageGuardrail — track per-conversation tasks_spawned + tool_calls and
 *    return a soft-halt signal when soft limits are reached.
 *
 * 4. Exported caps — MAX_RESUME_ATTEMPTS, MAX_BATCH_SIZE, USAGE_TASKS_SOFT_LIMIT,
 *    USAGE_TOOL_CALLS_SOFT_LIMIT. These are the hard loop-breaker values.
 *
 * Pointers-not-contents: this module never reads or returns plan/diff/file body
 * contents. All review and test results are pointer strings only (§1, §8).
 */

import { nanoid } from 'nanoid';
import { childLogger } from '../../logger.js';
import { getDb } from '../../db.js';
import { getManagedTask, upsertManagedTask } from '../store.js';
import { pushToConversation } from '../stream.js';
import type { ManagedTask } from '../store.js';

const logger = childLogger('orchestrator/mcp/verify');

// ─── Loop-breaker caps (exported for tests) ──────────────────────────────────

/** Maximum times a task may be retried (resumed with a fix) before halting. */
export const MAX_RESUME_ATTEMPTS = 5;

/** Maximum number of DAG tasks dispatched in a single scheduleDagStep call. */
export const MAX_BATCH_SIZE = 10;

/** Soft threshold for tasks spawned per conversation (usage guardrail). */
export const USAGE_TASKS_SOFT_LIMIT = 20;

/** Soft threshold for tool calls per conversation (usage guardrail). */
export const USAGE_TOOL_CALLS_SOFT_LIMIT = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RequestReviewInput {
  task_id: string;
  conversation_id: string;
}

export interface RequestReviewResult {
  /** Pointer to the review artifact (diff view URL or review task URL). Never file contents. */
  review_pointer: string;
  /** Test/CI status summary string (e.g. 'passing', 'failing', 'unknown'). Never test output. */
  tests_pointer: string;
}

export interface UsageDelta {
  tasks_spawned?: number;
  tool_calls?: number;
}

export interface ConversationUsage {
  conversation_id: string;
  tasks_spawned: number;
  tool_calls: number;
  started_at: string;
  last_activity_at: string;
}

export interface GuardrailResult {
  halted: boolean;
  reason?: string;
}

// ─── handleRequestReview ─────────────────────────────────────────────────────

/**
 * Route a completed task through the verifier and surface review + test pointers.
 *
 * Implements spec §6.4: a structurally-separate evaluator between "work done"
 * and "work accepted." The orchestrator receives only POINTERS — a diff_url and
 * a tests status string — never the review verdict prose or test output bodies.
 *
 * The managed_tasks phase is advanced to 'reviewing' to suppress any Stop-hook
 * auto-transition while the review is pending.
 */
export async function handleRequestReview(input: RequestReviewInput): Promise<RequestReviewResult> {
  const { task_id, conversation_id } = input;

  logger.info(
    { task_id, conversation_id, operation: 'handleRequestReview' },
    'handleRequestReview: start',
  );

  // Verify the task has a managed_tasks row
  const mt = getManagedTask(task_id);
  if (!mt || mt.conversation_id !== conversation_id) {
    throw new Error(
      `handleRequestReview: task ${task_id} not found in managed_tasks for conversation ${conversation_id}`,
    );
  }

  // Extract artifact pointers from the managed_tasks row (never file contents)
  let artifacts: Record<string, unknown> = {};
  if (mt.artifacts) {
    try {
      artifacts = JSON.parse(mt.artifacts) as Record<string, unknown>;
    } catch {
      logger.warn({ task_id }, 'handleRequestReview: could not parse artifacts JSON');
    }
  }

  // Diff view URL pointer — the UI renders the diff; the orchestrator holds the URL
  const diffUrl =
    typeof artifacts['diff_url'] === 'string'
      ? artifacts['diff_url']
      : `/tasks/${task_id}?view=diff`;

  // Tests status pointer — a short string summary, never test output
  const testsPointer = typeof artifacts['tests'] === 'string' ? artifacts['tests'] : '';

  // Advance phase to 'reviewing' to gate the Stop auto-human_review transition
  upsertManagedTask({
    conversation_id,
    task_id,
    phase: 'reviewing',
  });

  logger.info(
    { task_id, conversation_id, diff_url: diffUrl, tests: testsPointer },
    'handleRequestReview: advancing phase to reviewing',
  );

  // Push a ws message with review pointers to the conversation (never file contents)
  const reviewNote = [
    `[verifier] task \`${task_id}\` sent for review.`,
    `Diff view: ${diffUrl}`,
    testsPointer ? `Tests: ${testsPointer}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  pushToConversation(
    conversation_id,
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      text: reviewNote,
      review_pointer: diffUrl,
      tests_pointer: testsPointer,
    }),
  );

  return {
    review_pointer: diffUrl,
    tests_pointer: testsPointer,
  };
}

// ─── scheduleDagStep ─────────────────────────────────────────────────────────

/**
 * Walk the DAG after a phase transition and dispatch ready dependents.
 *
 * Called by the supervisor on 'task:phase_complete' and 'task:stuck' events,
 * and also directly by the verifier when a review completes (§9.1).
 *
 * Returns the list of task_ids that were marked ready for dispatch.
 * The supervisor/exec layer is responsible for actually starting those tasks;
 * this function only marks them and pushes appropriate ws events.
 */
export async function scheduleDagStep(
  conversationId: string,
  completedTaskId: string,
  completedPhase: string,
): Promise<string[]> {
  logger.debug(
    { conversation_id: conversationId, task_id: completedTaskId, phase: completedPhase },
    'scheduleDagStep: evaluating DAG',
  );

  const db = getDb();

  // Find all managed tasks for this conversation that have a depends_on list
  const allManaged = db
    .prepare(`SELECT * FROM managed_tasks WHERE conversation_id = ? AND depends_on IS NOT NULL`)
    .all(conversationId) as ManagedTask[];

  if (allManaged.length === 0) {
    return [];
  }

  const isFailure = completedPhase === 'error' || completedPhase === 'blocked';

  // ── Failure cascade ────────────────────────────────────────────────────────
  if (isFailure) {
    const blocked: string[] = [];

    for (const managed of allManaged) {
      // Skip if already in a terminal/blocked state
      if (managed.phase === 'done' || managed.phase === 'blocked') {
        continue;
      }

      let deps: string[] = [];
      try {
        deps = JSON.parse(managed.depends_on ?? '[]') as string[];
      } catch {
        continue;
      }

      if (deps.includes(completedTaskId)) {
        // Mark this task blocked
        upsertManagedTask({
          conversation_id: conversationId,
          task_id: managed.task_id,
          phase: 'blocked',
        });
        blocked.push(managed.task_id);
      }
    }

    if (blocked.length > 0) {
      // Surface ONE consolidated card listing all blocked tasks (§9.1)
      const cardId = nanoid(12);
      const consolidatedCard = {
        type: 'card' as const,
        id: cardId,
        command: 'dag-blocked',
        args: {
          failed_task_id: completedTaskId,
          blocked_task_ids: blocked,
          message: `Dependency \`${completedTaskId}\` failed. The following tasks are blocked: ${blocked.map((id) => `\`${id}\``).join(', ')}. Resolve the failure and retry, or skip blocked tasks.`,
        },
      };

      pushToConversation(conversationId, JSON.stringify(consolidatedCard));

      logger.info(
        {
          conversation_id: conversationId,
          failed_task_id: completedTaskId,
          blocked_count: blocked.length,
        },
        'scheduleDagStep: failure cascade — blocked dependents surfaced as one card',
      );
    }

    return [];
  }

  // ── Normal phase: only dispatch on 'done' ─────────────────────────────────
  if (completedPhase !== 'done') {
    return [];
  }

  const readyToDispatch: string[] = [];

  for (const managed of allManaged) {
    // Skip non-pending tasks
    if (managed.phase !== 'planning') {
      continue;
    }

    let deps: string[] = [];
    try {
      deps = JSON.parse(managed.depends_on ?? '[]') as string[];
    } catch {
      continue;
    }

    // Check whether ALL dependencies are done
    const allDepsDone = deps.every((depId) => {
      const depMt = getManagedTask(depId);
      return depMt?.phase === 'done';
    });

    if (allDepsDone) {
      readyToDispatch.push(managed.task_id);
    }
  }

  if (readyToDispatch.length === 0) {
    return [];
  }

  // ── Batch cap ─────────────────────────────────────────────────────────────
  const overCap = readyToDispatch.length > MAX_BATCH_SIZE;
  const toDispatch = overCap ? readyToDispatch.slice(0, MAX_BATCH_SIZE) : readyToDispatch;
  const capped = overCap ? readyToDispatch.slice(MAX_BATCH_SIZE) : [];

  if (overCap) {
    // Push a user-confirm note about the capped tasks
    const capNote = `[supervisor] Batch dispatch limit reached (${MAX_BATCH_SIZE} tasks). ${capped.length} tasks are waiting for the next dispatch cycle. Approve to continue: ${capped.map((id) => `\`${id}\``).join(', ')}`;

    pushToConversation(
      conversationId,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        text: capNote,
      }),
    );

    logger.warn(
      {
        conversation_id: conversationId,
        total_ready: readyToDispatch.length,
        dispatching: toDispatch.length,
        capped_count: capped.length,
      },
      'scheduleDagStep: batch cap exceeded — confirm required for remaining tasks',
    );
  }

  logger.info(
    {
      conversation_id: conversationId,
      dispatched: toDispatch,
      capped: capped.length,
    },
    'scheduleDagStep: dispatching ready tasks',
  );

  return toDispatch;
}

// ─── Usage guardrail helpers ──────────────────────────────────────────────────

/**
 * Increment per-conversation usage counters.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to create the row on first access and
 * atomically increment the counters on subsequent calls.
 *
 * Called by the gate/exec layer when a task is spawned or a tool call runs.
 */
export function incrementConversationUsage(conversationId: string, delta: UsageDelta): void {
  const db = getDb();
  const tasksSpawned = delta.tasks_spawned ?? 0;
  const toolCalls = delta.tool_calls ?? 0;

  db.prepare(
    `INSERT INTO conversation_usage (conversation_id, tasks_spawned, tool_calls)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       tasks_spawned    = tasks_spawned + excluded.tasks_spawned,
       tool_calls       = tool_calls + excluded.tool_calls,
       last_activity_at = datetime('now')`,
  ).run(conversationId, tasksSpawned, toolCalls);

  logger.debug(
    { conversation_id: conversationId, tasks_spawned: tasksSpawned, tool_calls: toolCalls },
    'incrementConversationUsage',
  );
}

/**
 * Return the current usage row for a conversation, or undefined if not yet created.
 */
export function getConversationUsage(conversationId: string): ConversationUsage | undefined {
  return getDb()
    .prepare(`SELECT * FROM conversation_usage WHERE conversation_id = ?`)
    .get(conversationId) as ConversationUsage | undefined;
}

/**
 * Check whether the conversation has reached a soft usage limit.
 *
 * Returns {halted: true, reason} if either tasks_spawned >= USAGE_TASKS_SOFT_LIMIT
 * or tool_calls >= USAGE_TOOL_CALLS_SOFT_LIMIT. Returns {halted: false} otherwise.
 *
 * The caller (gate, exec) should inject a confirm message into the conversation
 * before allowing further write-actions when halted=true.
 */
export function checkUsageGuardrail(conversationId: string): GuardrailResult {
  const usage = getConversationUsage(conversationId);
  if (!usage) {
    return { halted: false };
  }

  if (usage.tasks_spawned >= USAGE_TASKS_SOFT_LIMIT) {
    return {
      halted: true,
      reason: `${usage.tasks_spawned} tasks spawned in this conversation (limit: ${USAGE_TASKS_SOFT_LIMIT}). Continue?`,
    };
  }

  if (usage.tool_calls >= USAGE_TOOL_CALLS_SOFT_LIMIT) {
    return {
      halted: true,
      reason: `${usage.tool_calls} tool calls in this conversation (limit: ${USAGE_TOOL_CALLS_SOFT_LIMIT}). Continue?`,
    };
  }

  return { halted: false };
}
