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

import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import {
  getTask,
  listTasks,
  countTasks,
  countAgentsForTask,
  listAgentsByTasks,
  listPendingPromptsByTasks,
  listRecentRepoPaths,
} from '../../repositories/index.js';
import { getManagedTask, countManagedTasksByPhase, eventsSince } from '../store.js';
import { childLogger } from '../../logger.js';
import type { Task } from '../../types.js';

const execFile = promisify(execFileCb);

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

  // Fetch all non-deleted tasks (including auto_review), ordered newest-updated first.
  // listTasks orders by created_at; we replicate the original updated_at ordering in JS.
  let rows = listTasks({ includeAutoReview: true });

  // Apply workflow_status filter if provided
  if (workflow_status) {
    rows = rows.filter((t) => t.workflow_status === workflow_status);
  }

  // Sort by updated_at DESC (listTasks uses created_at ordering) then apply limit
  rows = rows.sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
  );
  rows = rows.slice(0, limit);

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

  const task = getTask(task_id);

  // Exclude soft-deleted tasks (getTask does not filter deleted_at)
  if (!task || task.deleted_at) {
    return null;
  }

  const agent_count = countAgentsForTask(task_id);

  return {
    id: task.id,
    title: task.title,
    runtime_state: task.runtime_state,
    workflow_status: task.workflow_status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    agent_count,
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

  // Total active (non-deleted) tasks
  const total = countTasks();

  // All non-deleted tasks (including auto_review) for rollup computation
  const allTasks = listTasks({ includeAutoReview: true });
  const taskIds = allTasks.map((t) => t.id);
  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));

  // Counts by runtime_state (JS groupBy)
  const by_runtime_state: Record<string, number> = {};
  for (const t of allTasks) {
    by_runtime_state[t.runtime_state] = (by_runtime_state[t.runtime_state] ?? 0) + 1;
  }

  // Counts by workflow_status (JS groupBy)
  const by_workflow_status: Record<string, number> = {};
  for (const t of allTasks) {
    by_workflow_status[t.workflow_status] = (by_workflow_status[t.workflow_status] ?? 0) + 1;
  }

  // Counts by managed phase across ALL managed_tasks rows (incl. soft-deleted
  // tasks), matching the original ungated GROUP BY.
  const by_phase = countManagedTasksByPhase();

  // Awaiting-approval set: only live (non-deleted) tasks, with their titles.
  const awaitingApprovalTasks: Array<{ id: string; title: string }> = [];
  for (const t of allTasks) {
    const mt = getManagedTask(t.id);
    if (mt && mt.phase === 'awaiting_approval') {
      awaitingApprovalTasks.push({ id: t.id, title: t.title });
    }
  }

  // Needs-attention: error tasks (filter from allTasks)
  const errorTasks = allTasks
    .filter((t) => t.runtime_state === 'error')
    .map((t) => ({ id: t.id, title: t.title }));

  // Needs-attention: tasks with pending permission prompts
  const pendingPrompts = listPendingPromptsByTasks(taskIds);
  const pendingPromptTaskIdSet = new Set(pendingPrompts.map((p) => p.task_id));
  const pendingPromptTasks = [...pendingPromptTaskIdSet]
    .map((id) => taskMap.get(id))
    .filter((t): t is Task => t !== undefined)
    .map((t) => ({ id: t.id, title: t.title }));

  // Needs-attention: tasks whose agents have hook_activity='waiting'
  const allAgents = listAgentsByTasks(taskIds);
  const hookWaitingTaskIdSet = new Set(
    allAgents
      .filter((a) => a.hook_activity === 'waiting' && a.task_id !== null)
      .map((a) => a.task_id as string),
  );
  const hookWaitingTasks = [...hookWaitingTaskIdSet]
    .map((id) => taskMap.get(id))
    .filter((t): t is Task => t !== undefined)
    .map((t) => ({ id: t.id, title: t.title }));

  // Needs-attention: tasks with task:stuck events (eventsSince(0) = all events)
  const allEvents = eventsSince(0);
  const stuckTaskIdSet = new Set(
    allEvents.filter((e) => e.type === 'task:stuck').map((e) => e.task_id),
  );
  const stuckTasks = [...stuckTaskIdSet]
    .filter((id) => taskMap.has(id))
    .map((id) => taskMap.get(id)!)
    .map((t) => ({ id: t.id, title: t.title }));

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
    total,
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

// ─── recent_repos ─────────────────────────────────────────────────────────────

export interface RecentRepoRow {
  repo_path: string;
  last_used: string;
}

/**
 * Return the 10 most-recently-used distinct repo paths from past tasks.
 * Never returns deleted tasks' repos.
 */
export function handleRecentRepos(): RecentRepoRow[] {
  logger.debug({ operation: 'recent_repos' }, 'recent_repos called');

  return listRecentRepoPaths(10) as RecentRepoRow[];
}

// ─── default_branch ───────────────────────────────────────────────────────────

export interface DefaultBranchInput {
  repo_path: string;
}

export interface DefaultBranchResult {
  branch: string;
}

/**
 * Return the default branch of a git repo by inspecting refs/remotes/origin/HEAD.
 * Falls back to 'main' on any error (missing remote, not a git repo, etc.).
 */
export async function handleDefaultBranch(input: DefaultBranchInput): Promise<DefaultBranchResult> {
  const { repo_path } = input;

  logger.debug({ operation: 'default_branch', repo_path }, 'default_branch called');

  try {
    const { stdout } = await execFile('git', [
      '-C',
      repo_path,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    const branch = stdout.trim().replace('refs/remotes/origin/', '');
    return { branch };
  } catch {
    logger.debug({ operation: 'default_branch', repo_path }, 'default_branch fallback to main');
    return { branch: 'main' };
  }
}
