import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { readGithubLogin, writeGithubLogin } from './config.js';

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
      expect(readGithubLogin()).toBe('new-user');
    });
  });
});
