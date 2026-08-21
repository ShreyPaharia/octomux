/**
 * Repository for `plugin_facts` — the append-only, task-scoped fact log
 * behind `ctx.facts` (see `server/plugins/facts.ts`, ruling R1 in
 * `plans/2026-08-20-plugin-runtime-p0.md`: its own table, not `events`).
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/plugin-facts');

export interface PluginFact {
  seq: number;
  taskId: string;
  /** Qualified — `core:diff`, `coverage-bot:coverage`. */
  type: string;
  payload: unknown;
  createdAt: string;
}

interface PluginFactRow {
  seq: number;
  task_id: string;
  type: string;
  payload: string;
  created_at: string;
}

function toFact(row: PluginFactRow): PluginFact {
  return {
    seq: row.seq,
    taskId: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

/** Appends a fact row. `type` must already be qualified (`<pluginId>:<type>`). */
export function insertFact(taskId: string, type: string, payload: unknown): PluginFact {
  const result = getDb()
    .prepare(`INSERT INTO plugin_facts (task_id, type, payload) VALUES (?, ?, ?)`)
    .run(taskId, type, JSON.stringify(payload ?? {}));
  const seq = Number(result.lastInsertRowid);
  logger.debug({ task_id: taskId, type, seq }, 'plugin fact inserted');
  return getFact(seq)!;
}

export function getFact(seq: number): PluginFact | undefined {
  const row = getDb().prepare(`SELECT * FROM plugin_facts WHERE seq = ?`).get(seq) as
    | PluginFactRow
    | undefined;
  return row ? toFact(row) : undefined;
}

export interface ReadFactsOptions {
  /** Qualified fact type to filter on. */
  type?: string;
  /** Only facts with `seq` strictly greater than this. */
  sinceSeq?: number;
}

/** Reads facts for a task, oldest first, with optional qualified-type and sinceSeq filters. */
export function readFactsForTask(taskId: string, opts: ReadFactsOptions = {}): PluginFact[] {
  const conditions = ['task_id = ?'];
  const params: Array<string | number> = [taskId];
  if (opts.type !== undefined) {
    conditions.push('type = ?');
    params.push(opts.type);
  }
  if (opts.sinceSeq !== undefined) {
    conditions.push('seq > ?');
    params.push(opts.sinceSeq);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM plugin_facts WHERE ${conditions.join(' AND ')} ORDER BY seq ASC`)
    .all(...params) as PluginFactRow[];
  return rows.map(toFact);
}

/** Deletes every fact for a task. Facts are task-scoped and die with the task —
 *  call from wherever the task row itself is hard-deleted. */
export function deleteFactsForTask(taskId: string): void {
  const result = getDb().prepare(`DELETE FROM plugin_facts WHERE task_id = ?`).run(taskId);
  logger.info({ task_id: taskId, deleted: result.changes }, 'plugin facts deleted for task');
}
