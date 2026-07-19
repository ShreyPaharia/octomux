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
  config_json: string | null;
}

export interface UpsertScheduleInput {
  kind: string;
  repoPath: string;
  cron: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Insert a schedule, or update cron/enabled/config on conflict for (kind, repo_path). */
export function upsertSchedule(input: UpsertScheduleInput): ScheduleRow {
  const id = nanoid(12);
  const enabled = input.enabled === false ? 0 : 1;
  const configJson = input.config ? JSON.stringify(input.config) : null;

  getDb()
    .prepare(
      `INSERT INTO schedules (id, kind, repo_path, cron, enabled, config_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, repo_path) DO UPDATE SET
         cron = excluded.cron,
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = datetime('now')`,
    )
    .run(id, input.kind, input.repoPath, input.cron, enabled, configJson);

  const row = getDb()
    .prepare(
      `SELECT id, kind, repo_path, cron, enabled, last_run_at, config_json FROM schedules
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
      `SELECT id, kind, repo_path, cron, enabled, last_run_at, config_json FROM schedules WHERE enabled = 1`,
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

/** All schedules, across every kind and enabled state — for the management UI. */
export function listSchedules(): ScheduleRow[] {
  return getDb()
    .prepare(`SELECT id, kind, repo_path, cron, enabled, last_run_at, config_json FROM schedules`)
    .all() as ScheduleRow[];
}

/** Fetch a single schedule by id (returns undefined if not found). */
export function getSchedule(id: string): ScheduleRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, kind, repo_path, cron, enabled, last_run_at, config_json FROM schedules WHERE id = ?`,
    )
    .get(id) as ScheduleRow | undefined;
}

export interface UpdateScheduleInput {
  cron?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Partially update a schedule's cron/enabled/config. Returns undefined if not found. */
export function updateSchedule(id: string, patch: UpdateScheduleInput): ScheduleRow | undefined {
  const existing = getSchedule(id);
  if (!existing) return undefined;

  const cron = patch.cron ?? existing.cron;
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  const configJson =
    patch.config !== undefined ? JSON.stringify(patch.config) : existing.config_json;

  getDb()
    .prepare(
      `UPDATE schedules SET cron = ?, enabled = ?, config_json = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(cron, enabled, configJson, id);

  logger.info({ schedule_id: id }, 'schedule updated');
  return getSchedule(id);
}

/** Delete a schedule by id. No-op if it doesn't exist. */
export function deleteSchedule(id: string): void {
  getDb().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  logger.info({ schedule_id: id }, 'schedule deleted');
}
