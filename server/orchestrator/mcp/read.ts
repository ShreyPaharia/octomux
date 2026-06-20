/**
 * server/orchestrator/mcp/read.ts
 *
 * Orchestrator MCP **read** tool handlers (Task 1.5 / SHR-121).
 *
 * These are thin wrappers over existing octomux DB functions that return
 * **lean summaries and pointers only** — never full row dumps, file bodies,
 * or diff contents. The orchestrator must hold pointers, not contents (§1, §8).
 *
 * Four tools:
 *   list_tasks      — paginated/filtered task list (id, title, statuses only)
 *   get_task        — lean task summary + agent_count pointer
 *   monitor_status  — cross-task rollup: counts + needs_attention list
 *   get_task_output — artifact pointers from managed_tasks.artifacts JSON
 *
 * These handlers are called both by the MCP server (server.ts) and by tests
 * directly so they are exported as plain functions (no transport coupling).
 */

import { getDb } from '../../db.js';
import { SELECT_TASK_SQL } from '../../task-select.js';
import { getManagedTask } from '../store.js';
import { childLogger } from '../../logger.js';
import type { Task } from '../../types.js';

const logger = childLogger('orchestrator/mcp/read');

// ─── Input types ──────────────────────────────────────────────────────────────

export interface ListTasksInput {
  /** Optional workflow_status filter (e.g. 'in_progress'). */
  workflow_status?: string;
  /** Maximum tasks to return (default 50). */
  limit?: number;
}

export interface GetTaskInput {
  task_id: string;
}

export type MonitorStatusInput = Record<string, never>;

export interface GetTaskOutputInput {
  task_id: string;
}

// ─── Output types ─────────────────────────────────────────────────────────────

/** Lean task summary returned by list_tasks and get_task. */
export interface TaskSummary {
  id: string;
  title: string;
  runtime_state: string;
  workflow_status: string;
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends TaskSummary {
  /** Number of agents on this task (pointer, not agent rows). */
  agent_count: number;
}

export interface MonitorStatusResult {
  total: number;
  by_runtime_state: Record<string, number>;
  by_workflow_status: Record<string, number>;
  /**
   * Counts by managed phase from managed_tasks (planning / awaiting_approval /
   * implementing / reviewing / done). Only present for orchestrator-managed tasks.
   */
  by_phase: Record<string, number>;
  /** Tasks in error state or awaiting attention (id + title only). */
  needs_attention: Array<{ id: string; title: string; reason: string }>;
}

/** Artifact pointers only. Contents are never returned. */
export interface TaskOutputPointers {
  /** Path to the plan artifact in the task's worktree (e.g. 'plan.json'). */
  plan?: string;
  /** URL to the diff view in the octomux dashboard. */
  diff_url?: string;
  /** Test run status as a short string (e.g. 'passing', 'failing'). */
  tests?: string;
}

// ─── list_tasks ───────────────────────────────────────────────────────────────

/**
 * List tasks as lean summaries (id, title, statuses only).
 * Never returns description, initial_prompt, error, or full agent rows.
 */
export function handleListTasks(input: ListTasksInput): TaskSummary[] {
  const { workflow_status, limit = 50 } = input;

  logger.debug({ operation: 'list_tasks', workflow_status, limit }, 'list_tasks called');

  let sql = `${SELECT_TASK_SQL} WHERE t.deleted_at IS NULL`;
  const params: unknown[] = [];

  if (workflow_status) {
    sql += ' AND t.workflow_status = ?';
    params.push(workflow_status);
  }

  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Task[];

  // Return lean summaries only — no description, no initial_prompt, no error
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    runtime_state: t.runtime_state,
    workflow_status: t.workflow_status,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));
}

// ─── get_task ─────────────────────────────────────────────────────────────────

/**
 * Get a lean task summary plus agent_count (a pointer, not agent rows).
 * Returns null for unknown task_id.
 */
export function handleGetTask(input: GetTaskInput): TaskDetail | null {
  const { task_id } = input;

  logger.debug({ operation: 'get_task', task_id }, 'get_task called');

  const task = getDb()
    .prepare(`${SELECT_TASK_SQL} WHERE t.id = ? AND t.deleted_at IS NULL`)
    .get(task_id) as Task | undefined;

  if (!task) {
    return null;
  }

  const agentCountRow = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM agents WHERE task_id = ?`)
    .get(task_id) as { n: number };

  return {
    id: task.id,
    title: task.title,
    runtime_state: task.runtime_state,
    workflow_status: task.workflow_status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    agent_count: agentCountRow.n,
  };
}

// ─── monitor_status ───────────────────────────────────────────────────────────

/**
 * Cross-task rollup: counts by runtime_state and workflow_status, plus a
 * needs_attention list for tasks that require human action (error, or tasks
 * with pending permission prompts).
 *
 * Returns summaries only — never full task rows.
 */
export function handleMonitorStatus(_input: MonitorStatusInput): MonitorStatusResult {
  logger.debug({ operation: 'monitor_status' }, 'monitor_status called');

  const db = getDb();

  // Total active tasks
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL`).get() as {
    n: number;
  };

  // Counts by runtime_state
  const runtimeRows = db
    .prepare(
      `SELECT runtime_state, COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL GROUP BY runtime_state`,
    )
    .all() as Array<{ runtime_state: string; n: number }>;
  const by_runtime_state: Record<string, number> = {};
  for (const r of runtimeRows) {
    by_runtime_state[r.runtime_state] = r.n;
  }

  // Counts by workflow_status
  const workflowRows = db
    .prepare(
      `SELECT workflow_status, COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL GROUP BY workflow_status`,
    )
    .all() as Array<{ workflow_status: string; n: number }>;
  const by_workflow_status: Record<string, number> = {};
  for (const r of workflowRows) {
    by_workflow_status[r.workflow_status] = r.n;
  }

  // Counts by managed phase (Task 5.3: monitor summaries)
  const phaseRows = db
    .prepare(`SELECT phase, COUNT(*) AS n FROM managed_tasks GROUP BY phase`)
    .all() as Array<{ phase: string; n: number }>;
  const by_phase: Record<string, number> = {};
  for (const r of phaseRows) {
    by_phase[r.phase] = r.n;
  }

  // Needs-attention: error tasks + tasks with pending permission prompts
  const errorTasks = db
    .prepare(
      `SELECT t.id, t.title FROM tasks t WHERE t.runtime_state = 'error' AND t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; title: string }>;

  const pendingPromptTasks = db
    .prepare(
      `SELECT DISTINCT t.id, t.title
         FROM tasks t
         INNER JOIN permission_prompts pp ON pp.task_id = t.id AND pp.status = 'pending'
         WHERE t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; title: string }>;

  // Needs-attention: tasks in awaiting_approval phase (waiting for human to approve)
  const awaitingApprovalTasks = db
    .prepare(
      `SELECT DISTINCT t.id, t.title
         FROM tasks t
         INNER JOIN managed_tasks mt ON mt.task_id = t.id AND mt.phase = 'awaiting_approval'
         WHERE t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; title: string }>;

  // Needs-attention: tasks whose agents have hook_activity='waiting'
  const hookWaitingTasks = db
    .prepare(
      `SELECT DISTINCT t.id, t.title
         FROM tasks t
         INNER JOIN agents a ON a.task_id = t.id AND a.hook_activity = 'waiting'
         WHERE t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; title: string }>;

  // Needs-attention: tasks with recent task:stuck events (most recent per task)
  const stuckTasks = db
    .prepare(
      `SELECT DISTINCT t.id, t.title
         FROM tasks t
         INNER JOIN events e ON e.task_id = t.id AND e.type = 'task:stuck'
         WHERE t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; title: string }>;

  const needs_attention: MonitorStatusResult['needs_attention'] = [
    ...errorTasks.map((t) => ({ id: t.id, title: t.title, reason: 'error' })),
    ...pendingPromptTasks.map((t) => ({ id: t.id, title: t.title, reason: 'pending_prompt' })),
    ...awaitingApprovalTasks.map((t) => ({
      id: t.id,
      title: t.title,
      reason: 'awaiting_approval',
    })),
    ...hookWaitingTasks.map((t) => ({ id: t.id, title: t.title, reason: 'hook_waiting' })),
    ...stuckTasks.map((t) => ({ id: t.id, title: t.title, reason: 'stuck' })),
  ];

  // Deduplicate by id (first reason wins — priority order: error > pending_prompt > awaiting_approval > hook_waiting > stuck)
  const seen = new Set<string>();
  const deduped = needs_attention.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return {
    total: totalRow.n,
    by_runtime_state,
    by_workflow_status,
    by_phase,
    needs_attention: deduped,
  };
}

// ─── get_task_output ──────────────────────────────────────────────────────────

/**
 * Return artifact pointers for a task from its managed_tasks.artifacts JSON.
 *
 * CRITICAL: this tool returns POINTERS ONLY — never file contents, never diff
 * bodies. The orchestrator may hold the path and diff_url; contents are fetched
 * browser-side by the UI via GET /api/orchestrator/artifact.
 *
 * Returns an empty object if the task has no managed_tasks row yet.
 */
export function handleGetTaskOutput(input: GetTaskOutputInput): TaskOutputPointers {
  const { task_id } = input;

  logger.debug({ operation: 'get_task_output', task_id }, 'get_task_output called');

  const mt = getManagedTask(task_id);
  if (!mt || !mt.artifacts) {
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(mt.artifacts) as Record<string, unknown>;
  } catch {
    logger.warn({ task_id, artifacts: mt.artifacts }, 'get_task_output: invalid artifacts JSON');
    return {};
  }

  const pointers: TaskOutputPointers = {};

  if (typeof parsed.plan === 'string') {
    pointers.plan = parsed.plan;
  }
  if (typeof parsed.diff_url === 'string') {
    pointers.diff_url = parsed.diff_url;
  }
  if (typeof parsed.tests === 'string') {
    pointers.tests = parsed.tests;
  }

  return pointers;
}
