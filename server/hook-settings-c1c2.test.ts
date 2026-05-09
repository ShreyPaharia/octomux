/**
 * C1 + C2: hook_settings table migration and dispatcher enabled-flag tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.js';
import { initDb } from './db.js';
import { isHookEnabled, invalidateHookEnabledCache } from './hook-dispatcher.js';

describe('C1: hook_settings table migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates the hook_settings table', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('hook_settings');
  });

  it('hook_settings has the correct columns', () => {
    const cols = (db.pragma('table_info(hook_settings)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('scope');
    expect(cols).toContain('key');
    expect(cols).toContain('enabled');
    expect(cols).toContain('updated_at');
  });

  it('(scope, key) is the primary key — duplicate upsert succeeds', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 1)`,
    ).run();
    expect(() => {
      db.prepare(
        `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 0)`,
      ).run();
    }).toThrow(); // unique constraint

    // But ON CONFLICT UPDATE works
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled, updated_at)
       VALUES ('global', 'stop/notify.sh', 0, datetime('now'))
       ON CONFLICT(scope, key) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
    ).run();

    const row = db
      .prepare(
        `SELECT enabled FROM hook_settings WHERE scope = 'global' AND key = 'stop/notify.sh'`,
      )
      .get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('is idempotent — running initDb a second time does not throw', () => {
    expect(() => initDb(db)).not.toThrow();
  });
});

describe('C2: isHookEnabled respects hook_settings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    invalidateHookEnabledCache(); // clear any cached state
  });

  afterEach(() => {
    invalidateHookEnabledCache();
    db.close();
  });

  it('returns true when no row exists (missing = enabled)', () => {
    expect(isHookEnabled('global', 'stop/notify.sh')).toBe(true);
  });

  it('returns true when row has enabled = 1', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 1)`,
    ).run();
    invalidateHookEnabledCache();
    expect(isHookEnabled('global', 'stop/notify.sh')).toBe(true);
  });

  it('returns false when row has enabled = 0', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 0)`,
    ).run();
    invalidateHookEnabledCache();
    expect(isHookEnabled('global', 'stop/notify.sh')).toBe(false);
  });

  it('caches the result on subsequent calls', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 1)`,
    ).run();
    invalidateHookEnabledCache();

    const first = isHookEnabled('global', 'stop/notify.sh');
    // Mutate the DB without invalidating
    db.prepare(
      `UPDATE hook_settings SET enabled = 0 WHERE scope = 'global' AND key = 'stop/notify.sh'`,
    ).run();
    const second = isHookEnabled('global', 'stop/notify.sh');
    // Should still be cached value
    expect(first).toBe(true);
    expect(second).toBe(true); // cache hit, not yet invalidated
  });

  it('cache invalidation picks up new value', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('global', 'stop/notify.sh', 1)`,
    ).run();
    invalidateHookEnabledCache();
    expect(isHookEnabled('global', 'stop/notify.sh')).toBe(true);

    // Toggle
    db.prepare(
      `UPDATE hook_settings SET enabled = 0 WHERE scope = 'global' AND key = 'stop/notify.sh'`,
    ).run();
    invalidateHookEnabledCache('global', 'stop/notify.sh');
    expect(isHookEnabled('global', 'stop/notify.sh')).toBe(false);
  });
});

describe('C2: fireHook skips disabled scripts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    invalidateHookEnabledCache();
  });

  afterEach(() => {
    invalidateHookEnabledCache();
    db.close();
  });

  it('disabled hook key → isHookEnabled returns false', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('repo:/tmp/my-repo', 'summary_updated/slack.sh', 0)`,
    ).run();
    invalidateHookEnabledCache();
    expect(isHookEnabled('repo:/tmp/my-repo', 'summary_updated/slack.sh')).toBe(false);
  });

  it('enabled hook key → isHookEnabled returns true', () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled) VALUES ('repo:/tmp/my-repo', 'summary_updated/slack.sh', 1)`,
    ).run();
    invalidateHookEnabledCache();
    expect(isHookEnabled('repo:/tmp/my-repo', 'summary_updated/slack.sh')).toBe(true);
  });
});
