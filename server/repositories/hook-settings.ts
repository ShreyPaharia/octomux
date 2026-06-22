/**
 * Repository layer for the `hook_settings` table.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/hook-settings');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HookSettingRow {
  scope: string;
  key: string;
  enabled: boolean;
  updated_at: string;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Read the enabled state for a (scope, key) pair.
 * Returns `defaultEnabled` when the row does not exist.
 * Results are NOT cached here — caching lives in hook-dispatcher.ts.
 */
export function getHookEnabled(scope: string, key: string, defaultEnabled = true): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT enabled FROM hook_settings WHERE scope = ? AND key = ?`)
      .get(scope, key) as { enabled: number } | undefined;
    if (row === undefined) return defaultEnabled;
    return row.enabled !== 0;
  } catch {
    // DB may not be ready — treat as defaultEnabled.
    return defaultEnabled;
  }
}

/** Fetch a single hook_setting row by (scope, key). Returns undefined if absent. */
export function getHookSetting(scope: string, key: string): HookSettingRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT scope, key, enabled, updated_at FROM hook_settings WHERE scope = ? AND key = ?`,
    )
    .get(scope, key) as
    | { scope: string; key: string; enabled: number; updated_at: string }
    | undefined;
  if (!row) return undefined;
  return { ...row, enabled: row.enabled !== 0 };
}

/** List all hook_settings rows (for admin/debug). */
export function listHookSettings(): HookSettingRow[] {
  const rows = getDb()
    .prepare(`SELECT scope, key, enabled, updated_at FROM hook_settings ORDER BY scope, key`)
    .all() as Array<{ scope: string; key: string; enabled: number; updated_at: string }>;
  return rows.map((r) => ({ ...r, enabled: r.enabled !== 0 }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upsert (INSERT OR REPLACE / ON CONFLICT UPDATE) a hook_settings row.
 * Returns the new enabled state.
 */
export function upsertHookSetting(scope: string, key: string, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO hook_settings (scope, key, enabled, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(scope, key) DO UPDATE SET
         enabled    = excluded.enabled,
         updated_at = datetime('now')`,
    )
    .run(scope, key, enabled ? 1 : 0);
  logger.info({ scope, key, enabled, operation: 'upsertHookSetting' }, 'hook setting upserted');
}
