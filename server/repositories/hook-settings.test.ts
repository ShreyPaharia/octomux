import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getHookEnabled, upsertHookSetting } from './hook-settings.js';

describe('repositories/hook-settings', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
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
      const row = db
        .prepare(`SELECT enabled FROM hook_settings WHERE scope = ? AND key = ?`)
        .get('repo:/tmp', 'my-event/script.sh') as { enabled: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(1);
    });

    it('updates an existing row on conflict', () => {
      upsertHookSetting('global', 'update/test', true);
      upsertHookSetting('global', 'update/test', false);
      expect(getHookEnabled('global', 'update/test')).toBe(false);
    });
  });
});
