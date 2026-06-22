/**
 * Repository layer for the `permission_prompts` table.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 *
 * Single owner of permission_prompts: hooks.ts, summarize.ts, inbox.ts,
 * task-runner.ts, and api.ts should all delegate to these functions.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/permission-prompts');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PermissionPromptRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  session_id: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
  /** Present when joined with agents (listPendingPromptsByTask / listPendingPromptsByTasks). */
  agent_label?: string | null;
}

/** Raw DB row — tool_input is stored as JSON text. */
interface PermissionPromptDbRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  session_id: string | null;
  tool_name: string;
  tool_input: string;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
  agent_label?: string | null;
}

function parseRow(row: PermissionPromptDbRow): PermissionPromptRow {
  return {
    ...row,
    tool_input: JSON.parse(row.tool_input ?? '{}') as Record<string, unknown>,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * List all pending permission prompts for a task, joined with agent label.
 * Used by GET /api/tasks/:id to build the pending_prompts array.
 */
export function listPendingPromptsByTask(taskId: string): PermissionPromptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id = ? AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
    )
    .all(taskId) as PermissionPromptDbRow[];
  return rows.map(parseRow);
}

/**
 * Bulk-fetch pending permission prompts for multiple task ids.
 * Returns all pending rows joined with agent label, ordered by created_at ASC.
 */
export function listPendingPromptsByTasks(taskIds: string[]): PermissionPromptRow[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT pp.*, a.label as agent_label
       FROM permission_prompts pp
       LEFT JOIN agents a ON pp.agent_id = a.id
       WHERE pp.task_id IN (${placeholders}) AND pp.status = 'pending'
       ORDER BY pp.created_at ASC`,
    )
    .all(...taskIds) as PermissionPromptDbRow[];
  return rows.map(parseRow);
}

/**
 * List recently-resolved permission prompts for a given agent within a time window.
 * Used by summarize.ts to build the agent's activity transcript.
 */
export function listRecentResolvedByAgent(
  agentId: string,
  since: string,
  limit = 10,
): PermissionPromptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT tool_name, tool_input, created_at
         FROM permission_prompts
        WHERE agent_id = ? AND resolved_at IS NOT NULL AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(agentId, since, limit) as PermissionPromptDbRow[];
  return rows.map(parseRow);
}

/** Count pending prompts for a task (used by the stop-hook B4 transition guard). */
export function countPendingByTask(taskId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM permission_prompts WHERE task_id = ? AND status = 'pending'`,
    )
    .get(taskId) as { n: number };
  return row.n;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface InsertPermissionPromptInput {
  id?: string;
  task_id: string;
  agent_id: string | null;
  session_id: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/**
 * Insert a pending permission prompt. Returns the generated id.
 * tool_input is JSON-serialized on write.
 */
export function insertPermissionPrompt(input: InsertPermissionPromptInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO permission_prompts
         (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    )
    .run(
      id,
      input.task_id,
      input.agent_id,
      input.session_id,
      input.tool_name,
      JSON.stringify(input.tool_input),
    );
  logger.info(
    {
      task_id: input.task_id,
      agent_id: input.agent_id,
      prompt_id: id,
      operation: 'insertPermissionPrompt',
    },
    'permission prompt inserted',
  );
  return id;
}

/**
 * Resolve all pending permission prompts for a task (called on closeTask).
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
 * Resolve all pending permission prompts for a single agent (called on stopAgent / stop hook).
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

/**
 * Resolve the oldest pending prompt for a given agent (FIFO, post-tool-use).
 * Called by the post-tool-use hook when the tool completes.
 */
export function resolveOldestPendingByAgent(agentId: string): void {
  getDb()
    .prepare(
      `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
         WHERE id = (
           SELECT id FROM permission_prompts
           WHERE agent_id = ? AND status = 'pending'
           ORDER BY created_at ASC LIMIT 1
         )`,
    )
    .run(agentId);
  logger.debug(
    { agent_id: agentId, operation: 'resolveOldestPendingByAgent' },
    'oldest pending prompt resolved',
  );
}
