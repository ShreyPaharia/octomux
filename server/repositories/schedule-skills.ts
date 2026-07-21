/**
 * Repository layer for the `schedule_skills` table — one editable prompt body
 * per cron workflow kind, seeded once from the shipped SKILL.md and the sole
 * source of truth thereafter. Plain exported functions — no base class, no ORM.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/schedule-skills');

export interface ScheduleSkillRow {
  kind: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/** Fetch the DB body for a cron kind (undefined if never seeded). */
export function getScheduleSkillRow(kind: string): ScheduleSkillRow | undefined {
  return getDb()
    .prepare(`SELECT kind, content, created_at, updated_at FROM schedule_skills WHERE kind = ?`)
    .get(kind) as ScheduleSkillRow | undefined;
}

/** Insert or replace the body for a cron kind. */
export function upsertScheduleSkill(kind: string, content: string): ScheduleSkillRow {
  getDb()
    .prepare(
      `INSERT INTO schedule_skills (kind, content)
       VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
    )
    .run(kind, content);
  logger.info({ kind }, 'schedule skill upserted');
  return getScheduleSkillRow(kind)!;
}

/** Delete the DB body for a cron kind so the next read re-seeds from SKILL.md. */
export function deleteScheduleSkill(kind: string): boolean {
  const info = getDb().prepare(`DELETE FROM schedule_skills WHERE kind = ?`).run(kind);
  if (info.changes > 0) logger.info({ kind }, 'schedule skill deleted');
  return info.changes > 0;
}
