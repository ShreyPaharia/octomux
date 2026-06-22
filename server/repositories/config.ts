/**
 * Repository layer for the `config` table.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 *
 * The config table is a singleton row (id = 1) that stores process-wide
 * configuration such as the cached GitHub login.
 */
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/config');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfigRow {
  id: number;
  github_login: string | null;
  updated_at: string;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Read the singleton config row (id = 1). Returns undefined when absent. */
export function getConfig(): ConfigRow | undefined {
  return getDb().prepare('SELECT * FROM config WHERE id = 1').get() as ConfigRow | undefined;
}

/** Read just the github_login from the config row. Returns null when absent. */
export function readGithubLogin(): string | null {
  const row = getDb().prepare('SELECT github_login FROM config WHERE id = 1').get() as
    | { github_login: string | null }
    | undefined;
  return row?.github_login ?? null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upsert the singleton config row with a GitHub login.
 * Uses INSERT OR REPLACE with ON CONFLICT so a missing row is created.
 */
export function writeGithubLogin(login: string): void {
  getDb()
    .prepare(
      `INSERT INTO config (id, github_login, updated_at) VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         github_login = excluded.github_login,
         updated_at   = datetime('now')`,
    )
    .run(login);
  logger.info({ github_login: login, operation: 'writeGithubLogin' }, 'github_login cached');
}
