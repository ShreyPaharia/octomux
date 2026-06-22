/**
 * Repository layer for the `team_schedules` and `team_runs` tables.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/team-schedules');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamScheduleRow {
  name: string;
  repo_path: string;
  config_path: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamRunRow {
  id: string;
  team: string;
  lead_task_id: string;
  started_at: string;
  status: string;
}

// ─── team_schedules reads ─────────────────────────────────────────────────────

/** List all team_schedules rows ordered by name. */
export function listTeamSchedules(): TeamScheduleRow[] {
  return getDb().prepare(`SELECT * FROM team_schedules ORDER BY name`).all() as TeamScheduleRow[];
}

/** List enabled team_schedules rows (used by poller). */
export function listEnabledTeamSchedules(): TeamScheduleRow[] {
  return getDb()
    .prepare(`SELECT * FROM team_schedules WHERE enabled = 1`)
    .all() as TeamScheduleRow[];
}

/** Fetch a single team_schedule by name. */
export function getTeamSchedule(name: string): TeamScheduleRow | undefined {
  return getDb().prepare(`SELECT * FROM team_schedules WHERE name = ?`).get(name) as
    | TeamScheduleRow
    | undefined;
}

// ─── team_schedules writes ────────────────────────────────────────────────────

export interface UpsertTeamScheduleInput {
  name: string;
  repoPath: string;
  configPath: string;
  cron: string;
}

/** Upsert a team_schedule row (insert or update on conflict). */
export function upsertTeamSchedule(input: UpsertTeamScheduleInput): void {
  getDb()
    .prepare(
      `INSERT INTO team_schedules (name, repo_path, config_path, cron, enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         repo_path   = excluded.repo_path,
         config_path = excluded.config_path,
         cron        = excluded.cron,
         enabled     = 1,
         updated_at  = datetime('now')`,
    )
    .run(input.name, input.repoPath, input.configPath, input.cron);
  logger.info({ team: input.name, operation: 'upsertTeamSchedule' }, 'team schedule upserted');
}

/** Touch last_run_at to now for a schedule. */
export function touchTeamScheduleLastRun(name: string): void {
  getDb()
    .prepare(`UPDATE team_schedules SET last_run_at = datetime('now') WHERE name = ?`)
    .run(name);
  logger.info(
    { team: name, operation: 'touchTeamScheduleLastRun' },
    'team schedule last_run_at updated',
  );
}

// ─── team_runs reads ──────────────────────────────────────────────────────────

/**
 * Find an active (status='running') team_run where the linked Lead task is still
 * actually running. Used by the poller for idempotency.
 */
export function findActiveTeamRun(teamName: string): { id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT tr.id FROM team_runs tr
       INNER JOIN tasks t ON tr.lead_task_id = t.id
       WHERE tr.team = ?
         AND tr.status = 'running'
         AND t.runtime_state IN ('running', 'setting_up')
       LIMIT 1`,
    )
    .get(teamName) as { id: string } | undefined;
}

/** List all team_runs for a given team, newest first. */
export function listTeamRuns(teamName: string): TeamRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM team_runs WHERE team = ? ORDER BY started_at DESC`)
    .all(teamName) as TeamRunRow[];
}

// ─── team_runs writes ─────────────────────────────────────────────────────────

/** Insert a new team_run row. Returns the generated id. */
export function insertTeamRun(input: { team: string; lead_task_id: string }): string {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO team_runs (id, team, lead_task_id, started_at, status)
       VALUES (?, ?, ?, datetime('now'), 'running')`,
    )
    .run(id, input.team, input.lead_task_id);
  logger.info(
    { team: input.team, lead_task_id: input.lead_task_id, run_id: id, operation: 'insertTeamRun' },
    'team run inserted',
  );
  return id;
}

/**
 * Mark a team_run as done for a given lead_task_id (called by poller when the
 * lead task's tmux session disappears).
 */
export function completeTeamRunByLeadTask(leadTaskId: string): void {
  getDb()
    .prepare(`UPDATE team_runs SET status = 'done' WHERE lead_task_id = ? AND status = 'running'`)
    .run(leadTaskId);
  logger.info(
    { lead_task_id: leadTaskId, operation: 'completeTeamRunByLeadTask' },
    'team run marked done',
  );
}
