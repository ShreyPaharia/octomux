import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { LoopRun, LoopIteration, LoopEmitStatus } from '../types.js';

const logger = childLogger('loop-runs');

export interface CreateLoopRunInput {
  task_id: string;
  spec_json: string;
  max_iterations?: number | null;
  budget_json?: string | null;
}

export function createLoopRun(input: CreateLoopRunInput): LoopRun {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO loop_runs (id, task_id, spec_json, max_iterations, budget_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.spec_json,
      input.max_iterations ?? null,
      input.budget_json ?? null,
    );
  const row = getLoopRun(id);
  if (!row) throw new Error('failed to read loop_run after insert');
  logger.info({ task_id: input.task_id, loop_run_id: id }, 'loop_run created');
  return row;
}

export function getLoopRun(id: string): LoopRun | undefined {
  return getDb().prepare(`SELECT * FROM loop_runs WHERE id = ?`).get(id) as LoopRun | undefined;
}

export function listLoopRuns(): LoopRun[] {
  return getDb().prepare(`SELECT * FROM loop_runs ORDER BY created_at DESC`).all() as LoopRun[];
}

export function listIterationsForRun(loopRunId: string): LoopIteration[] {
  return getDb()
    .prepare(`SELECT * FROM loop_iterations WHERE loop_run_id = ? ORDER BY n ASC`)
    .all(loopRunId) as LoopIteration[];
}

export interface AppendIterationInput {
  sha_from?: string | null;
  sha_to?: string | null;
  verify_passed?: number | null;
  tokens?: number | null;
}

/** Insert the next iteration row for a loop run, auto-incrementing `n`. */
export function appendIteration(loopRunId: string, row: AppendIterationInput): LoopIteration {
  const db = getDb();
  const id = nanoid(12);
  const { n } = db
    .prepare(`SELECT COALESCE(MAX(n), 0) + 1 AS n FROM loop_iterations WHERE loop_run_id = ?`)
    .get(loopRunId) as { n: number };

  db.prepare(
    `INSERT INTO loop_iterations (id, loop_run_id, n, sha_from, sha_to, verify_passed, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    loopRunId,
    n,
    row.sha_from ?? null,
    row.sha_to ?? null,
    row.verify_passed ?? null,
    row.tokens ?? null,
  );

  db.prepare(`UPDATE loop_runs SET iteration = ?, updated_at = datetime('now') WHERE id = ?`).run(
    n,
    loopRunId,
  );

  logger.info({ loop_run_id: loopRunId, n }, 'loop_iteration appended');
  return db.prepare(`SELECT * FROM loop_iterations WHERE id = ?`).get(id) as LoopIteration;
}

export interface RecordEmitInput {
  status: LoopEmitStatus;
  reason: string;
}

/** Set loop_runs.status + the latest iteration's emit_status/emit_reason. */
export function recordEmit(loopRunId: string, input: RecordEmitInput): void {
  const db = getDb();
  db.prepare(
    `UPDATE loop_runs SET status = ?, termination_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(input.status, input.reason, loopRunId);

  const latest = db
    .prepare(`SELECT id FROM loop_iterations WHERE loop_run_id = ? ORDER BY n DESC LIMIT 1`)
    .get(loopRunId) as { id: string } | undefined;
  if (latest) {
    db.prepare(`UPDATE loop_iterations SET emit_status = ?, emit_reason = ? WHERE id = ?`).run(
      input.status,
      input.reason,
      latest.id,
    );
  }

  logger.info({ loop_run_id: loopRunId, status: input.status }, 'loop_run emit recorded');
}
