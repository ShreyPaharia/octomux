import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import type Database from 'better-sqlite3';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { getOrCreateRepoConfig, updateRepoConfig, listRepoConfigs } from './repo-config.js';
import { execFile } from 'child_process';

const mockExecFile = vi.mocked(execFile);

describe('repo-config', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getOrCreateRepoConfig', () => {
    it('auto-detects default branch and creates config on first call', async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          cb(null, { stdout: 'refs/remotes/origin/main\n', stderr: '' });
        }
      }) as any);

      const config = await getOrCreateRepoConfig('/tmp/test-repo');

      expect(config.repo_path).toBe('/tmp/test-repo');
      expect(config.base_branch).toBe('main');
      expect(config.test_command).toBe('bun run test');
      expect(config.format_command).toBe('bun run format');
      expect(config.lint_command).toBe('bun run lint:fix');
    });

    it('returns existing config on subsequent calls without shelling out', async () => {
      db.prepare(`INSERT INTO repo_configs (repo_path, base_branch) VALUES (?, ?)`).run(
        '/tmp/test-repo',
        'staging',
      );

      const config = await getOrCreateRepoConfig('/tmp/test-repo');

      expect(config.base_branch).toBe('staging');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('falls back to null when git detection fails', async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          cb(new Error('not a git repo'), { stdout: '', stderr: '' });
        }
      }) as any);

      const config = await getOrCreateRepoConfig('/tmp/no-git');

      expect(config.base_branch).toBeNull();
    });
  });

  describe('updateRepoConfig', () => {
    it('updates specified fields and returns updated config', () => {
      db.prepare(`INSERT INTO repo_configs (repo_path, base_branch) VALUES (?, ?)`).run(
        '/tmp/test-repo',
        'main',
      );

      const config = updateRepoConfig('/tmp/test-repo', { base_branch: 'staging' });

      expect(config.base_branch).toBe('staging');
      expect(config.test_command).toBe('bun run test');
    });

    it('throws when repo config does not exist', () => {
      expect(() => updateRepoConfig('/tmp/nope', { base_branch: 'x' })).toThrow();
    });
  });

  describe('listRepoConfigs', () => {
    it('returns all configs sorted by repo_path', () => {
      db.prepare(`INSERT INTO repo_configs (repo_path, base_branch) VALUES (?, ?)`).run(
        '/z-repo',
        'main',
      );
      db.prepare(`INSERT INTO repo_configs (repo_path, base_branch) VALUES (?, ?)`).run(
        '/a-repo',
        'staging',
      );

      const configs = listRepoConfigs();

      expect(configs).toHaveLength(2);
      expect(configs[0].repo_path).toBe('/a-repo');
      expect(configs[1].repo_path).toBe('/z-repo');
    });
  });
});
