import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getConfig, readGithubLogin, writeGithubLogin } from './config.js';

describe('repositories/config', () => {
  beforeEach(() => {
    createTestDb();
  });

  describe('readGithubLogin', () => {
    it('returns null when config table is empty', () => {
      expect(readGithubLogin()).toBeNull();
    });

    it('returns the stored login after writeGithubLogin', () => {
      writeGithubLogin('octocat');
      expect(readGithubLogin()).toBe('octocat');
    });
  });

  describe('writeGithubLogin', () => {
    it('upserts the singleton row', () => {
      writeGithubLogin('first-user');
      writeGithubLogin('second-user');
      expect(readGithubLogin()).toBe('second-user');
    });

    it('creates the config row when absent', () => {
      writeGithubLogin('new-user');
      const row = getConfig();
      expect(row).toBeDefined();
      expect(row!.id).toBe(1);
      expect(row!.github_login).toBe('new-user');
    });
  });

  describe('getConfig', () => {
    it('returns undefined when config is empty', () => {
      expect(getConfig()).toBeUndefined();
    });

    it('returns the config row after write', () => {
      writeGithubLogin('test-login');
      const row = getConfig();
      expect(row).toBeDefined();
      expect(row!.github_login).toBe('test-login');
      expect(row!.updated_at).toBeTruthy();
    });
  });
});
