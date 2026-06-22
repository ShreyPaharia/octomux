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

/**
 * Fetch the tmux_session for a standalone chat agent (task_id IS NULL).
 * Used by the chat terminal WebSocket handler.
 */
export function getChatAgentTmuxSession(
  chatId: string,
): { tmux_session: string | null } | undefined {
  return getDb()
    .prepare(`SELECT tmux_session FROM agents WHERE id = ? AND task_id IS NULL`)
    .get(chatId) as { tmux_session: string | null } | undefined;
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

/** Set the hook_token for an agent (used by ensureHookToken backfill). */
export function setAgentHookToken(agentId: string, token: string): void {
  getDb().prepare(`UPDATE agents SET hook_token = ? WHERE id = ?`).run(token, agentId);
}

/** Update the harness_session_id for an agent (called when a new session id is minted on resume/hop). */
export function setAgentHarnessSessionId(agentId: string, sessionId: string): void {
  getDb().prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(sessionId, agentId);
  logger.info(
    { agent_id: agentId, operation: 'setAgentHarnessSessionId' },
    'agent harness_session_id updated',
  );
}

export interface InsertChatAgentInput {
  id: string;
  label: string;
  harness_id: string;
  harness_session_id: string | null;
  hook_token: string;
  tmux_session: string;
  agent: string | null;
}

/**
 * Insert a standalone chat agent row (task_id NULL, window_index 0,
 * status='running', hook_activity='active'). Used by createChat.
 */
export function insertChatAgent(input: InsertChatAgentInput): void {
  getDb()
    .prepare(
      `INSERT INTO agents
         (id, task_id, window_index, label, status, harness_id, harness_session_id,
          hook_token, hook_activity, tmux_session, agent, created_at)
       VALUES (?, NULL, 0, ?, 'running', ?, ?, ?, 'active', ?, ?, datetime('now'))`,
    )
    .run(
      input.id,
      input.label,
      input.harness_id,
      input.harness_session_id,
      input.hook_token,
      input.tmux_session,
      input.agent,
    );
}

/** List all standalone chat agents (task_id IS NULL), oldest first. */
export function listChatAgents(): Agent[] {
  return getDb()
    .prepare(
      `SELECT * FROM agents
         WHERE task_id IS NULL
         ORDER BY created_at ASC`,
    )
    .all() as Agent[];
}

/** Fetch a single standalone chat agent by id (task_id IS NULL). */
export function getChatAgent(id: string): Agent | undefined {
  return getDb().prepare(`SELECT * FROM agents WHERE id = ? AND task_id IS NULL`).get(id) as
    | Agent
    | undefined;
}

/** Mark a single agent's status='stopped' (used by createChat failure path). */
export function setAgentStopped(agentId: string): void {
  getDb().prepare(`UPDATE agents SET status = 'stopped' WHERE id = ?`).run(agentId);
}

/**
 * Mark a chat agent stopped + idle (used by closeChat).
 */
export function stopChatAgent(agentId: string): void {
  getDb()
    .prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle',
         hook_activity_updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(agentId);
}

/** Hard-delete a single agent row (used by deleteChat). */
export function deleteAgentRow(agentId: string): void {
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(agentId);
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

/** Update user_terminal status by id. */
export function updateUserTerminalStatus(id: string, status: 'idle' | 'working'): void {
  getDb().prepare('UPDATE user_terminals SET status = ? WHERE id = ?').run(status, id);
}

/**
 * List all user_terminals joined with their task's tmux_session,
 * for tasks that are currently running with a live tmux session.
 * Used by pollTerminalActivity.
 */
export function listRunningTerminals(): Array<UserTerminal & { tmux_session: string }> {
  return getDb()
    .prepare(
      `SELECT ut.*, t.tmux_session
       FROM user_terminals ut
       JOIN tasks t ON t.id = ut.task_id
       WHERE t.runtime_state = 'running' AND t.tmux_session IS NOT NULL`,
    )
    .all() as Array<UserTerminal & { tmux_session: string }>;
}

/**
 * Find a single agent by harness_session_id (non-stopped).
 * Used by resolveHookAgent / findAgentBySessionId.
 */
export function findAgentByHarnessSession(
  sessionId: string,
): { id: string; task_id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT a.id, a.task_id FROM agents a
       WHERE a.harness_session_id = ? AND a.status != 'stopped'
       LIMIT 1`,
    )
    .get(sessionId) as { id: string; task_id: string } | undefined;
}

/**
 * Verify that at least one agent row exists with the given hook_token.
 * Used by requireHookToken middleware.
 */
export function checkAgentTokenExists(token: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS ok FROM agents WHERE hook_token = ? AND hook_token != '' LIMIT 1`)
    .get(token) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * Find an exact agent match for a (hook_token, harness_session_id) pair.
 * Used by findAgentByTokenAndSession step 1.
 */
export function findAgentByTokenAndExactSession(
  token: string,
  sessionId: string,
): { id: string; task_id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id, task_id FROM agents
       WHERE hook_token = ? AND harness_session_id = ?
       LIMIT 1`,
    )
    .get(token, sessionId) as { id: string; task_id: string } | undefined;
}

/**
 * Find the most-recent agent with a given hook_token whose harness_session_id is NULL.
 * Used by findAgentByTokenAndSession step 2 (harness-issued session binding).
 */
export function findAgentByTokenWithNullSession(
  token: string,
): { id: string; task_id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id, task_id FROM agents
       WHERE hook_token = ? AND harness_session_id IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(token) as { id: string; task_id: string } | undefined;
}

/**
 * List all non-stopped agents for a hook_token.
 * Used by resolveHookAgent to detect single-agent ambiguity.
 */
export function findActiveAgentsByToken(token: string): Array<{ id: string; task_id: string }> {
  return getDb()
    .prepare(
      `SELECT id, task_id FROM agents
       WHERE hook_token = ? AND hook_token != '' AND status != 'stopped'`,
    )
    .all(token) as Array<{ id: string; task_id: string }>;
}

/** Set hook_activity and update hook_activity_updated_at for an agent. */
export function setAgentHookActivity(
  agentId: string,
  activity: 'active' | 'waiting' | 'idle',
): void {
  getDb()
    .prepare(
      `UPDATE agents SET hook_activity = ?, hook_activity_updated_at = datetime('now') WHERE id = ?`,
    )
    .run(activity, agentId);
}

/**
 * Set hook_activity to 'active' only when it is not already 'idle'.
 * Used by post-tool-use: a Stop hook may have fired first.
 */
export function setAgentHookActivityIfNotIdle(agentId: string): void {
  getDb()
    .prepare(
      `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
       WHERE id = ? AND hook_activity != 'idle'`,
    )
    .run(agentId);
}

/** Count non-stopped running agents for a task, excluding a specific agent id. */
export function countRunningAgentsExcept(taskId: string, excludeAgentId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM agents WHERE task_id = ? AND status = 'running' AND id != ?`,
    )
    .get(taskId, excludeAgentId) as { n: number };
  return row.n;
}

/**
 * List agents being watched for sub-agent completion notification:
 * running agents with a notify_agent_id, in running tasks with a live tmux session.
 * Used by pollAgentWindows.
 */
export function listWatchedAgents(): Array<{
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  tmux_session: string;
  notify_agent_id: string;
}> {
  return getDb()
    .prepare(
      `SELECT a.id, a.task_id, a.window_index, a.label,
              t.tmux_session, a.notify_agent_id
       FROM agents a
       INNER JOIN tasks t ON a.task_id = t.id
       WHERE a.status = 'running'
         AND a.notify_agent_id IS NOT NULL
         AND t.runtime_state = 'running'
         AND t.tmux_session IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    task_id: string;
    window_index: number;
    label: string;
    tmux_session: string;
    notify_agent_id: string;
  }>;
}

/**
 * Find the notify target agent+session for a given notify_agent_id.
 * Returns window_index + tmux_session only when the target is non-stopped and its
 * task is running. Used by pollAgentWindows to deliver completion messages.
 */
export function getNotifyAgentTarget(
  notifyAgentId: string,
): { window_index: number; tmux_session: string } | undefined {
  return getDb()
    .prepare(
      `SELECT a.window_index, t.tmux_session
       FROM agents a
       INNER JOIN tasks t ON a.task_id = t.id
       WHERE a.id = ? AND a.status != 'stopped' AND t.runtime_state = 'running'`,
    )
    .get(notifyAgentId) as { window_index: number; tmux_session: string } | undefined;
}

// permission_prompts functions have moved to ./permission-prompts.ts
