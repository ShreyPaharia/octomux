/**
 * Repository layer for the `agents` and `user_terminals` tables.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 *
 * Named `agent-runtime` to avoid colliding with the existing
 * `server/agents.ts` skeleton-definitions file.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { Agent, UserTerminal } from '../types.js';

const logger = childLogger('repositories/agent-runtime');

// ─── Agent reads ──────────────────────────────────────────────────────────────

/** Fetch a single agent by id. */
export function getAgent(id: string): Agent | undefined {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

/** List all non-stopped agents for a task, ordered by window_index. */
export function listActiveAgents(taskId: string): Agent[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE task_id = ? AND status != 'stopped' ORDER BY window_index`)
    .all(taskId) as Agent[];
}

/** List all stopped agents for a task, ordered by window_index. */
export function listStoppedAgents(taskId: string): Agent[] {
  return getDb()
    .prepare(`SELECT * FROM agents WHERE task_id = ? AND status = 'stopped' ORDER BY window_index`)
    .all(taskId) as Agent[];
}

/**
 * Fetch the hook_token shared by all agents in a task.
 * Returns undefined if no agent with a non-empty token exists yet.
 */
export function getTaskHookToken(taskId: string): { hook_token: string } | undefined {
  return getDb()
    .prepare(`SELECT hook_token FROM agents WHERE task_id = ? AND hook_token != '' LIMIT 1`)
    .get(taskId) as { hook_token: string } | undefined;
}

/** Fetch a single agent by id and task_id (returns undefined if not found or wrong task). */
export function getAgentByIdAndTask(agentId: string, taskId: string): Agent | undefined {
  return getDb()
    .prepare('SELECT * FROM agents WHERE id = ? AND task_id = ?')
    .get(agentId, taskId) as Agent | undefined;
}

/** Fetch the first non-stopped agent for a task, ordered by window_index. */
export function findFirstActiveAgent(
  taskId: string,
): { id: string; window_index: number } | undefined {
  return getDb()
    .prepare(
      `SELECT id, window_index FROM agents
       WHERE task_id = ? AND status != 'stopped'
       ORDER BY window_index ASC LIMIT 1`,
    )
    .get(taskId) as { id: string; window_index: number } | undefined;
}

/**
 * List all pending permission prompts for a task, joined with agent label.
 * Used by GET /api/tasks/:id to build the pending_prompts array.
 */
export function listPendingPromptsByTask(taskId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id = ? AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
    )
    .all(taskId) as Array<Record<string, unknown>>;
}

/**
 * Bulk-fetch pending permission prompts for multiple task ids.
 * Returns all pending rows joined with agent label, ordered by created_at ASC.
 */
export function listPendingPromptsByTasks(taskIds: string[]): Array<Record<string, unknown>> {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id IN (${placeholders}) AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
    )
    .all(...taskIds) as Array<Record<string, unknown>>;
}

/**
 * Bulk-fetch all agents for a set of task ids, ordered by window_index.
 * Used by the GET /api/tasks list endpoint.
 */
export function listAgentsByTasks(taskIds: string[]): Agent[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM agents WHERE task_id IN (${placeholders}) ORDER BY window_index`)
    .all(...taskIds) as Agent[];
}

/**
 * Bulk-fetch all user_terminals for a set of task ids, ordered by window_index.
 * Used by the GET /api/tasks list endpoint.
 */
export function listUserTerminalsByTasks(taskIds: string[]): UserTerminal[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT * FROM user_terminals WHERE task_id IN (${placeholders}) ORDER BY window_index`,
    )
    .all(...taskIds) as UserTerminal[];
}

/** Fetch a single user_terminal by id and task_id. */
export function getUserTerminalByIdAndTask(
  terminalId: string,
  taskId: string,
): UserTerminal | undefined {
  return getDb()
    .prepare('SELECT * FROM user_terminals WHERE id = ? AND task_id = ?')
    .get(terminalId, taskId) as UserTerminal | undefined;
}

/** List all agents for a task (all statuses), ordered by window_index. */
export function listAllAgents(taskId: string): Agent[] {
  return getDb()
    .prepare('SELECT * FROM agents WHERE task_id = ? ORDER BY window_index')
    .all(taskId) as Agent[];
}

/** List all user_terminals for a task, ordered by window_index. */
export function listUserTerminals(taskId: string): UserTerminal[] {
  return getDb()
    .prepare('SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index')
    .all(taskId) as UserTerminal[];
}

// ─── Agent writes ─────────────────────────────────────────────────────────────

export interface InsertAgentInput {
  id?: string;
  task_id: string | null;
  window_index: number;
  label: string;
  harness_id: string;
  harness_session_id?: string | null;
  hook_token: string;
  agent?: string | null;
  notify_agent_id?: string | null;
}

/** Insert a new agent row (first agent on task start). Returns the agent id. */
export function insertAgent(input: InsertAgentInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO agents
         (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.window_index,
      input.label,
      input.harness_id,
      input.harness_session_id ?? null,
      input.hook_token,
      input.agent ?? null,
    );
  logger.info({ agent_id: id, task_id: input.task_id, operation: 'insertAgent' }, 'agent inserted');
  return id;
}

/** Insert a new agent row with notify_agent_id (used by addAgent). Returns the agent id. */
export function insertAgentWithNotify(input: InsertAgentInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO agents
         (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent, notify_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.window_index,
      input.label,
      input.harness_id,
      input.harness_session_id ?? null,
      input.hook_token,
      input.agent ?? null,
      input.notify_agent_id ?? null,
    );
  logger.info(
    { agent_id: id, task_id: input.task_id, operation: 'insertAgentWithNotify' },
    'agent inserted (with notify)',
  );
  return id;
}

/** Update the harness_session_id for an agent (called when a new session id is minted on resume/hop). */
export function setAgentHarnessSessionId(agentId: string, sessionId: string): void {
  getDb().prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(sessionId, agentId);
  logger.info(
    { agent_id: agentId, operation: 'setAgentHarnessSessionId' },
    'agent harness_session_id updated',
  );
}

/** Update window_index and status='running' for an agent (called per agent on resumeTask). */
export function setAgentWindowRunning(agentId: string, windowIndex: number): void {
  getDb()
    .prepare(`UPDATE agents SET window_index = ?, status = 'running' WHERE id = ?`)
    .run(windowIndex, agentId);
  logger.info(
    { agent_id: agentId, window_index: windowIndex, operation: 'setAgentWindowRunning' },
    'agent window_index and status set to running',
  );
}

/** Mark all agents for a task as stopped + idle (used on closeTask and resumeTask pre-kill). */
export function stopAllAgents(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ?`,
    )
    .run(taskId);
  logger.info({ task_id: taskId, operation: 'stopAllAgents' }, 'all agents stopped');
}

/**
 * Mark all non-stopped agents for a task as stopped + idle.
 * Narrower than stopAllAgents — only transitions agents that are still running.
 * Used by resumeTask to reconcile DB before recreating tmux session.
 */
export function stopRunningAgents(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ? AND status != 'stopped'`,
    )
    .run(taskId);
  logger.info({ task_id: taskId, operation: 'stopRunningAgents' }, 'running agents stopped');
}

/**
 * Mark running agents as stopped for a soft-deleted task.
 * Only transitions agents currently in 'running' status.
 */
export function stopRunningAgentsOnDelete(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE agents
          SET status = 'stopped',
              hook_activity = 'idle',
              hook_activity_updated_at = datetime('now')
        WHERE task_id = ? AND status = 'running'`,
    )
    .run(taskId);
  logger.info(
    { task_id: taskId, operation: 'stopRunningAgentsOnDelete' },
    'running agents stopped on soft-delete',
  );
}

/** Mark a single agent as stopped + idle (used by stopAgent). */
export function stopAgent(agentId: string): void {
  getDb()
    .prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE id = ?`,
    )
    .run(agentId);
  logger.info({ agent_id: agentId, operation: 'stopAgent' }, 'agent stopped');
}

/**
 * Update an agent for task-hopping: set task_id, window_index, tmux_session,
 * status='running', hook_activity='active', hook_activity_updated_at=now.
 */
export function hopAgentToTask(
  agentId: string,
  targetTaskId: string | null,
  windowIndex: number,
  tmuxSession: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE agents
          SET task_id = ?, window_index = ?, tmux_session = ?, status = 'running',
              hook_activity = 'active', hook_activity_updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(targetTaskId, windowIndex, tmuxSession, agentId);
  logger.info(
    {
      agent_id: agentId,
      to_task_id: targetTaskId,
      window_index: windowIndex,
      operation: 'hopAgentToTask',
    },
    'agent hopped to task',
  );
}

// ─── user_terminals reads ─────────────────────────────────────────────────────

/** Count user_terminals rows for a task. */
export function countUserTerminals(taskId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM user_terminals WHERE task_id = ?')
    .get(taskId) as { count: number };
  return row.count;
}

// ─── user_terminals writes ────────────────────────────────────────────────────

export interface InsertUserTerminalInput {
  id?: string;
  task_id: string;
  window_index: number;
  label: string;
}

/** Insert a new user_terminal row. Returns the UserTerminal shape. */
export function insertUserTerminal(input: InsertUserTerminalInput): UserTerminal {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(`INSERT INTO user_terminals (id, task_id, window_index, label) VALUES (?, ?, ?, ?)`)
    .run(id, input.task_id, input.window_index, input.label);
  logger.info(
    { task_id: input.task_id, terminal_id: id, operation: 'insertUserTerminal' },
    'user terminal inserted',
  );
  return {
    id,
    task_id: input.task_id,
    window_index: input.window_index,
    label: input.label,
    status: 'idle',
    created_at: new Date().toISOString(),
  };
}

/** Delete all user_terminals for a task. */
export function deleteUserTerminalsByTask(taskId: string): void {
  getDb().prepare('DELETE FROM user_terminals WHERE task_id = ?').run(taskId);
  logger.info(
    { task_id: taskId, operation: 'deleteUserTerminalsByTask' },
    'user terminals deleted by task',
  );
}

/** Delete a single user_terminal by id. */
export function deleteUserTerminal(id: string): void {
  getDb().prepare('DELETE FROM user_terminals WHERE id = ?').run(id);
  logger.info({ terminal_id: id, operation: 'deleteUserTerminal' }, 'user terminal deleted');
}

// ─── permission_prompts agent-lifecycle helpers ───────────────────────────────

/**
 * Resolve all pending permission prompts for a task (called on closeTask).
 * Stored here because it's part of agent lifecycle teardown.
 */
export function resolveTaskPermissionPrompts(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
       WHERE task_id = ? AND status = 'pending'`,
    )
    .run(taskId);
  logger.info(
    { task_id: taskId, operation: 'resolveTaskPermissionPrompts' },
    'task permission prompts resolved',
  );
}

/**
 * Resolve all pending permission prompts for a single agent (called on stopAgent).
 */
export function resolveAgentPermissionPrompts(agentId: string): void {
  getDb()
    .prepare(
      `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
       WHERE agent_id = ? AND status = 'pending'`,
    )
    .run(agentId);
  logger.info(
    { agent_id: agentId, operation: 'resolveAgentPermissionPrompts' },
    'agent permission prompts resolved',
  );
}
