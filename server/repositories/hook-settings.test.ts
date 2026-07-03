import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  getHookEnabled,
  getHookSetting,
  listHookSettings,
  upsertHookSetting,
} from './hook-settings.js';

describe('repositories/hook-settings', () => {
  beforeEach(() => {
    createTestDb();
  });

  // ─── getHookEnabled ────────────────────────────────────────────────────────

  describe('getHookEnabled', () => {
    it('returns defaultEnabled (true) when row is absent', () => {
      expect(getHookEnabled('global', 'missing/key')).toBe(true);
    });

    it('returns defaultEnabled (false) when explicitly passed and row absent', () => {
      expect(getHookEnabled('builtin', 'summarize-progress', false)).toBe(false);
    });

    it('returns the stored enabled value when present', () => {
      upsertHookSetting('global', 'my/hook', false);
      expect(getHookEnabled('global', 'my/hook')).toBe(false);
    });

    it('returns true after upserting enabled=true', () => {
      upsertHookSetting('builtin', 'some-hook', false);
      upsertHookSetting('builtin', 'some-hook', true);
      expect(getHookEnabled('builtin', 'some-hook')).toBe(true);
    });
  });

  // ─── upsertHookSetting ────────────────────────────────────────────────────

  describe('upsertHookSetting', () => {
    it('inserts a new row', () => {
      upsertHookSetting('repo:/tmp', 'my-event/script.sh', true);
      const row = getHookSetting('repo:/tmp', 'my-event/script.sh');
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(true);
    });

    it('updates an existing row on conflict', () => {
      upsertHookSetting('global', 'update/test', true);
      upsertHookSetting('global', 'update/test', false);
      const row = getHookSetting('global', 'update/test');
      expect(row!.enabled).toBe(false);
    });
  });

  // ─── getHookSetting ───────────────────────────────────────────────────────

  describe('getHookSetting', () => {
    it('returns undefined for unknown (scope, key)', () => {
      expect(getHookSetting('global', 'never/inserted')).toBeUndefined();
    });

    it('returns the row with enabled as boolean', () => {
      upsertHookSetting('builtin', 'summarize-progress', false);
      const row = getHookSetting('builtin', 'summarize-progress');
      expect(row).toBeDefined();
      expect(row!.scope).toBe('builtin');
      expect(row!.key).toBe('summarize-progress');
      expect(row!.enabled).toBe(false);
    });
  });

  // ─── listHookSettings ────────────────────────────────────────────────────

  describe('listHookSettings', () => {
    it('returns all rows ordered by scope, key', () => {
      upsertHookSetting('global', 'b-event/script', true);
      upsertHookSetting('builtin', 'summarize-progress', false);
      upsertHookSetting('global', 'a-event/script', true);
      const rows = listHookSettings();
      expect(rows.length).toBeGreaterThanOrEqual(3);
      // Ordered by scope then key: builtin comes before global
      const scopes = rows.map((r) => r.scope);
      expect(scopes.indexOf('builtin')).toBeLessThan(scopes.indexOf('global'));
    });
  });
});
