/**
 * Repository layer for the `runs` table — a unified log of every workflow
 * invocation (task, loop, chat, or headless agent-session), regardless of
 * which primitive executed it. Plain exported functions — no base class.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/runs');

export interface RunRow {
  id: string;
  workflow_kind: string;
  trigger: string;
  schedule_id: string | null;
  task_id: string | null;
  chat_id: string | null;
  loop_run_id: string | null;
  status: string;
  result_json: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface InsertRunInput {
  workflowKind: string;
  trigger: string;
  scheduleId?: string | null;
  taskId?: string | null;
  chatId?: string | null;
  loopRunId?: string | null;
}

/** Insert a new run row with status 'running'. */
export function insertRun(input: InsertRunInput): RunRow {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO runs (id, workflow_kind, trigger, schedule_id, task_id, chat_id, loop_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.workflowKind,
      input.trigger,
      input.scheduleId ?? null,
      input.taskId ?? null,
      input.chatId ?? null,
      input.loopRunId ?? null,
    );

  const row = getRun(id);
  if (!row) throw new Error('failed to read run after insert');
  logger.info({ run_id: id, workflow_kind: input.workflowKind }, 'run created');
  return row;
}

export interface FinishRunInput {
  status: 'done' | 'failed' | 'blocked';
  result?: unknown;
  error?: string;
}

/** Terminal update: status, result_json (if given), error, ended_at. */
export function finishRun(id: string, input: FinishRunInput): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, result_json = ?, error = ?, ended_at = datetime('now') WHERE id = ?`,
    )
    .run(
      input.status,
      input.result !== undefined ? JSON.stringify(input.result) : null,
      input.error ?? null,
      id,
    );
  logger.info({ run_id: id, status: input.status }, 'run finished');
}

export function getRun(id: string): RunRow | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
}

const LIST_WITH_EFFECTIVE_STATUS_SQL = `
  SELECT runs.*, COALESCE(t.runtime_state, runs.status) AS effective_status
  FROM runs
  LEFT JOIN tasks t ON runs.task_id = t.id
`;

export function listRunsForWorkflow(kind: string): Array<RunRow & { effective_status: string }> {
  return getDb()
    .prepare(
      `${LIST_WITH_EFFECTIVE_STATUS_SQL} WHERE runs.workflow_kind = ? ORDER BY runs.started_at DESC`,
    )
    .all(kind) as Array<RunRow & { effective_status: string }>;
}

export function listRunsForSchedule(
  scheduleId: string,
): Array<RunRow & { effective_status: string }> {
  return getDb()
    .prepare(
      `${LIST_WITH_EFFECTIVE_STATUS_SQL} WHERE runs.schedule_id = ? ORDER BY runs.started_at DESC`,
    )
    .all(scheduleId) as Array<RunRow & { effective_status: string }>;
}
