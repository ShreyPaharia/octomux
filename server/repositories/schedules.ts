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
  name: string | null;
  cron: string;
  timezone: string | null;
  enabled: number;
  model: string | null;
  timeout_ms: number | null;
  last_run_at: string | null;
  config_json: string | null;
  prompt: string | null;
}

export interface CreateScheduleInput {
  kind: string;
  repoPath: string;
  cron: string;
  name?: string;
  timezone?: string;
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  config?: Record<string, unknown>;
  prompt?: string;
}

export interface UpdateScheduleInput {
  name?: string | null;
  repoPath?: string;
  cron?: string;
  timezone?: string | null;
  enabled?: boolean;
  model?: string | null;
  timeoutMs?: number | null;
  config?: Record<string, unknown>;
  prompt?: string | null;
}

const SCHEDULE_COLUMNS =
  'id, kind, repo_path, name, cron, timezone, enabled, model, timeout_ms, last_run_at, config_json, prompt';

/** Insert a new schedule row (pure insert — no upsert semantics). Returns the freshly inserted row. */
export function createSchedule(input: CreateScheduleInput): ScheduleRow {
  const id = nanoid(12);
  const enabled = input.enabled === false ? 0 : 1;
  const configJson = input.config ? JSON.stringify(input.config) : null;

  getDb()
    .prepare(
      `INSERT INTO schedules (id, kind, repo_path, name, cron, timezone, enabled, model, timeout_ms, config_json, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.repoPath,
      input.name ?? null,
      input.cron,
      input.timezone ?? null,
      enabled,
      input.model ?? null,
      input.timeoutMs ?? null,
      configJson,
      input.prompt ?? null,
    );

  const row = getDb()
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`)
    .get(id) as ScheduleRow;

  logger.info({ schedule_id: row.id, kind: input.kind }, 'schedule created');
  return row;
}

/** All enabled schedules, across every kind — the poller dispatches by `kind`. */
export function listEnabledSchedules(): ScheduleRow[] {
  return getDb()
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE enabled = 1`)
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
  return getDb().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules`).all() as ScheduleRow[];
}

/** Fetch a single schedule by id (returns undefined if not found). */
export function getSchedule(id: string): ScheduleRow | undefined {
  return getDb().prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`).get(id) as
    | ScheduleRow
    | undefined;
}

/** Partially update a schedule's fields. Returns undefined if not found. */
export function updateSchedule(id: string, patch: UpdateScheduleInput): ScheduleRow | undefined {
  const existing = getSchedule(id);
  if (!existing) return undefined;

  const cron = patch.cron ?? existing.cron;
  const repoPath = patch.repoPath ?? existing.repo_path;
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  const configJson =
    patch.config !== undefined ? JSON.stringify(patch.config) : existing.config_json;
  // null in patch means "clear it"; undefined means "keep existing"
  const name = 'name' in patch ? (patch.name ?? null) : existing.name;
  const timezone = 'timezone' in patch ? (patch.timezone ?? null) : existing.timezone;
  const model = 'model' in patch ? (patch.model ?? null) : existing.model;
  const timeoutMs = 'timeoutMs' in patch ? (patch.timeoutMs ?? null) : existing.timeout_ms;
  const prompt = 'prompt' in patch ? (patch.prompt ?? null) : existing.prompt;

  getDb()
    .prepare(
      `UPDATE schedules
       SET cron = ?, repo_path = ?, enabled = ?, config_json = ?, name = ?,
           timezone = ?, model = ?, timeout_ms = ?, prompt = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(cron, repoPath, enabled, configJson, name, timezone, model, timeoutMs, prompt, id);

  logger.info({ schedule_id: id }, 'schedule updated');
  return getSchedule(id);
}

/** Delete a schedule by id. No-op if it doesn't exist. */
export function deleteSchedule(id: string): void {
  getDb().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  logger.info({ schedule_id: id }, 'schedule deleted');
}
