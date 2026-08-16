/**
 * Service layer for task creation.
 * HTTP-agnostic: depends only on repos, task-runner, and broadcast.
 * Never imports express or touches req/res.
 */

import { nanoid } from 'nanoid';
import {
  insertWorktree,
  insertWorktreeInUse,
  insertTask,
  getTask,
  inTransaction,
  validateDependsOn,
  isDependencyUnmet,
  listDependentsAwaitingStart,
  setRuntimeState,
} from '../repositories/index.js';
import { upsertManagedTask } from '../repositories/orchestrator.js';
import { startTask, resumeTask } from '../task-engine/index.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import { ServiceError } from './errors.js';

const logger = childLogger('task-service');
import type { Task, RunMode, WorktreeStatus } from '../types.js';

// ─── DTO ─────────────────────────────────────────────────────────────────────

export interface CreateTaskServiceInput {
  /** Resolved title (never empty). */
  resolved_title: string;
  /** Resolved description. */
  resolved_description: string;
  /** Raw initial_prompt (stored as-is in the tasks row). */
  initial_prompt: string | null;
  /**
   * Resolved prompt stored in `tasks.initial_prompt`.
   * When absent defaults to `initial_prompt`.
   * exec passes a template-wrapped version here; the api handler passes null
   * (meaning use initial_prompt as-is).
   */
  resolved_prompt?: string | null;

  run_mode: RunMode;
  /** Absolute path to the repo (empty string for scratch). */
  stored_repo_path: string;
  /**
   * Staged path written to `worktrees.path`.
   * - api (new mode):   '' (task-runner fills it in during setup)
   * - api (existing):   worktree_path
   * - api (none):       storedRepoPath
   * - exec:             storedWorktree ?? storedRepoPath
   */
  staged_path: string;

  branch: string | null;
  base_branch: string | null;
  /** Only exec sets this to 'in_use'; api always passes 'available'. */
  worktree_status: WorktreeStatus;

  /** Initial runtime_state for the task row. */
  runtime_state: string;
  workflow_status: string;

  agent: string | null;
  harness_id: string;
  model: string | null;
  notify_task_id: string | null;
  /** When true the task is a draft — startTask is NOT fired. */
  is_draft: boolean;
  /**
   * Another task's id this one depends on. When set and that task hasn't
   * reached workflow_status 'done' yet, startTask is NOT fired (mirrors
   * is_draft's effect) and the row is inserted with runtime_state='idle'
   * regardless of what the caller passed — see the depends_on gate below.
   */
  depends_on?: string | null;

  /** When set, upsert a managed_tasks row inside the transaction. */
  managed?: {
    conversation_id: string;
    phase: string;
  };
}

export interface CreateTaskResult {
  task: Task;
  task_id: string;
}

// ─── createTask ───────────────────────────────────────────────────────────────

/**
 * Mint IDs, wrap worktree + task insert in a single transaction, read back the
 * Task, broadcast task:created, and (unless draft, or blocked on an unmet
 * depends_on) fire-and-forget startTask.
 *
 * Maps UNIQUE-constraint errors → ServiceError(msg, 409).
 * Maps an invalid depends_on (nonexistent task) → ServiceError(msg, 400).
 */
export async function createTask(input: CreateTaskServiceInput): Promise<Task> {
  const id = nanoid(12);
  const worktreeId = nanoid(12);

  const storedPrompt =
    input.resolved_prompt !== undefined ? input.resolved_prompt : input.initial_prompt;

  // A brand-new id can never already appear in a depends_on chain, so only
  // existence needs checking here (taskId=null) — the cycle walk is for
  // task.move re-pointing an EXISTING task's depends_on.
  if (input.depends_on) {
    const err = validateDependsOn(null, input.depends_on);
    if (err) throw new ServiceError(err, 400);
  }
  // A task waiting on an unmet dependency never gets startTask fired — same
  // effect as draft, but the row still carries its intended workflow_status
  // (e.g. 'in_progress') so listDependentsAwaitingStart can find and start it
  // once the dependency reaches 'done' (see unblockDependents below).
  const dependencyUnmet = isDependencyUnmet(input.depends_on ?? null);

  try {
    inTransaction(() => {
      if (input.worktree_status === 'in_use') {
        insertWorktreeInUse({
          id: worktreeId,
          path: input.staged_path,
          repo_path: input.run_mode === 'scratch' ? null : input.stored_repo_path || null,
          branch: input.branch,
          base_branch: input.base_branch,
          mode: input.run_mode,
        });
      } else {
        insertWorktree({
          id: worktreeId,
          path: input.staged_path,
          repo_path: input.run_mode === 'scratch' ? null : input.stored_repo_path || null,
          branch: input.branch,
          base_branch: input.base_branch,
          mode: input.run_mode,
          status: input.worktree_status,
        });
      }

      insertTask({
        id,
        title: input.resolved_title,
        description: input.resolved_description,
        runtime_state: dependencyUnmet ? 'idle' : input.runtime_state,
        workflow_status: input.workflow_status,
        initial_prompt: storedPrompt ?? null,
        worktree_id: worktreeId,
        agent: input.agent,
        harness_id: input.harness_id,
        model: input.model,
        notify_task_id: input.notify_task_id,
        depends_on: input.depends_on ?? null,
      });

      if (input.managed) {
        upsertManagedTask({
          conversation_id: input.managed.conversation_id,
          task_id: id,
          phase: input.managed.phase,
        });
      }
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (String(e.message).includes('UNIQUE constraint')) {
      throw new ServiceError(e.message, 409);
    }
    throw err;
  }

  const created = getTask(id) as Task;
  created.workers = [];
  created.user_terminals = [];

  broadcast({ type: 'task:created', payload: { taskId: id } });

  if (!input.is_draft && !dependencyUnmet) {
    // Fire-and-forget: startTask runs in background, broadcasts task:updated when done.
    startTask(created)
      .then(() => {
        broadcast({ type: 'task:updated', payload: { taskId: id } });
      })
      .catch((err: unknown) => {
        logger.error({ task_id: id, operation: 'createTask', err }, 'createTask: startTask failed');
        broadcast({ type: 'task:updated', payload: { taskId: id } });
      });
  }

  return created;
}

// ─── unblockDependents ──────────────────────────────────────────────────────

/**
 * Auto-start/resume every task that was waiting on `dependencyTaskId` to
 * finish (see listDependentsAwaitingStart). Call this wherever a task's
 * workflow_status transitions to 'done' — the minimum useful semantics for
 * the depends_on primitive: a blocked task becomes eligible once its
 * dependency is done. Fire-and-forget per task, mirroring createTask's own
 * startTask call site above.
 */
export function unblockDependents(dependencyTaskId: string): void {
  for (const task of listDependentsAwaitingStart(dependencyTaskId)) {
    setRuntimeState(task.id, 'setting_up', null);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    const run = task.worktree ? resumeTask(task) : startTask(task);
    run
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch((err: unknown) => {
        logger.error(
          { task_id: task.id, operation: 'unblockDependents', err },
          'unblockDependents: start failed',
        );
        broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      });
  }
}
