/**
 * Repository layer for the `schedules` table — generic cron-trigger rows
 * consumed by the schedule poller (`server/poller/schedule-cron.ts`).
 * Plain exported functions — no base class, no ORM.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/schedules');

export interface ScheduleRow {
  id: string;
  kind: string;
  repo_path: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
}

export interface UpsertScheduleInput {
  kind: string;
  repoPath: string;
  cron: string;
  enabled?: boolean;
}

/** Insert a schedule, or update cron/enabled on conflict for (kind, repo_path). */
export function upsertSchedule(input: UpsertScheduleInput): ScheduleRow {
  const id = nanoid(12);
  const enabled = input.enabled === false ? 0 : 1;

  getDb()
    .prepare(
      `INSERT INTO schedules (id, kind, repo_path, cron, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, repo_path) DO UPDATE SET
         cron = excluded.cron,
         enabled = excluded.enabled,
         updated_at = datetime('now')`,
    )
    .run(id, input.kind, input.repoPath, input.cron, enabled);

  const row = getDb()
    .prepare(
      `SELECT id, kind, repo_path, cron, enabled, last_run_at FROM schedules
       WHERE kind = ? AND repo_path = ?`,
    )
    .get(input.kind, input.repoPath) as ScheduleRow;

  logger.info({ schedule_id: row.id, kind: input.kind }, 'schedule upserted');
  return row;
}

/** All enabled schedules, across every kind — the poller dispatches by `kind`. */
export function listEnabledSchedules(): ScheduleRow[] {
  return getDb()
    .prepare(
      `SELECT id, kind, repo_path, cron, enabled, last_run_at FROM schedules WHERE enabled = 1`,
    )
    .all() as ScheduleRow[];
}

/** Stamp `last_run_at` after a schedule fires, whether or not the handler succeeded. */
export function touchScheduleLastRun(id: string): void {
  getDb()
    .prepare(
      `UPDATE schedules SET last_run_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}
