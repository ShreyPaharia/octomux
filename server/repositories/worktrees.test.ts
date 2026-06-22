import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  getWorktree,
  getWorktreeByPath,
  listWorktreesByRepo,
  insertWorktree,
  insertWorktreeInUse,
  setWorktreeStatus,
  touchWorktreeUsed,
  releaseWorktree,
  deleteWorktree,
  updateWorktreeOnSetup,
  setWorktreeBase,
  listTrackedRepoPaths,
  listTasksForWorktree,
  updateWorktreeFields,
} from './worktrees.js';

describe('repositories/worktrees', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── insertWorktree / getWorktree round-trip ─────────────────────────────────

  describe('insertWorktree / getWorktree', () => {
    it('inserts and reads back a worktree', () => {
      const id = insertWorktree({
        path: '/tmp/wt',
        repo_path: '/tmp/repo',
        branch: 'agents/fix',
        base_branch: 'main',
        mode: 'new',
        status: 'available',
      });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      const wt = getWorktree(id);
      expect(wt).toBeDefined();
      expect(wt!.path).toBe('/tmp/wt');
      expect(wt!.repo_path).toBe('/tmp/repo');
      expect(wt!.branch).toBe('agents/fix');
      expect(wt!.mode).toBe('new');
      expect(wt!.status).toBe('available');
    });

    it('created_at is non-null', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      const wt = getWorktree(id);
      expect(wt!.created_at).not.toBeNull();
    });

    it('returns undefined for unknown id', () => {
      expect(getWorktree('no-such')).toBeUndefined();
    });

    it('accepts explicit id', () => {
      insertWorktree({ id: 'my-wt-id', path: '/p', mode: 'existing' });
      expect(getWorktree('my-wt-id')).toBeDefined();
    });
  });

  // ─── insertWorktreeInUse ──────────────────────────────────────────────────────

  describe('insertWorktreeInUse', () => {
    it('inserts with status=in_use and last_used_at set', () => {
      const id = insertWorktreeInUse({ path: '/p', mode: 'new' });
      const wt = getWorktree(id);
      expect(wt!.status).toBe('in_use');
      expect(wt!.last_used_at).not.toBeNull();
    });
  });

  // ─── getWorktreeByPath ────────────────────────────────────────────────────────

  describe('getWorktreeByPath', () => {
    it('finds a worktree by its path', () => {
      insertWorktree({ id: 'w1', path: '/specific/path', mode: 'new' });
      const wt = getWorktreeByPath('/specific/path');
      expect(wt).toBeDefined();
      expect(wt!.id).toBe('w1');
    });

    it('returns undefined for unknown path', () => {
      expect(getWorktreeByPath('/unknown/path')).toBeUndefined();
    });
  });

  // ─── setWorktreeStatus ────────────────────────────────────────────────────────

  describe('setWorktreeStatus', () => {
    it.each(['available', 'in_use'] as const)('sets status to %s', (status) => {
      const id = insertWorktree({ path: '', mode: 'new', status: 'available' });
      setWorktreeStatus(id, status);
      expect(getWorktree(id)!.status).toBe(status);
    });
  });

  // ─── touchWorktreeUsed / releaseWorktree ──────────────────────────────────────

  describe('touch and release', () => {
    it('touchWorktreeUsed updates last_used_at', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      touchWorktreeUsed(id);
      const wt = getWorktree(id);
      expect(wt!.last_used_at).not.toBeNull();
    });

    it('releaseWorktree sets status=available and last_used_at', () => {
      const id = insertWorktreeInUse({ path: '', mode: 'new' });
      releaseWorktree(id);
      const wt = getWorktree(id);
      expect(wt!.status).toBe('available');
      expect(wt!.last_used_at).not.toBeNull();
    });
  });

  // ─── updateWorktreeOnSetup ────────────────────────────────────────────────────

  describe('updateWorktreeOnSetup', () => {
    it('updates all setup fields', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      updateWorktreeOnSetup(id, {
        path: '/new/path',
        repo_path: '/repo',
        branch: 'agents/abc',
        base_branch: 'main',
        base_sha: 'abc123',
        mode: 'new',
      });
      const wt = getWorktree(id);
      expect(wt!.path).toBe('/new/path');
      expect(wt!.repo_path).toBe('/repo');
      expect(wt!.branch).toBe('agents/abc');
      expect(wt!.base_branch).toBe('main');
      expect(wt!.base_sha).toBe('abc123');
      expect(wt!.status).toBe('in_use');
      expect(wt!.last_used_at).not.toBeNull();
    });
  });

  // ─── setWorktreeBase ──────────────────────────────────────────────────────────

  describe('setWorktreeBase', () => {
    it('updates base_branch and base_sha', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      setWorktreeBase(id, 'develop', 'deadbeef');
      const wt = getWorktree(id);
      expect(wt!.base_branch).toBe('develop');
      expect(wt!.base_sha).toBe('deadbeef');
    });
  });

  // ─── deleteWorktree ───────────────────────────────────────────────────────────

  describe('deleteWorktree', () => {
    it('removes the row', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      deleteWorktree(id);
      expect(getWorktree(id)).toBeUndefined();
    });
  });

  // ─── listWorktreesByRepo ──────────────────────────────────────────────────────

  describe('listWorktreesByRepo', () => {
    it('returns only worktrees for the given repo', () => {
      insertWorktree({ id: 'w1', path: '/a', repo_path: '/repo1', mode: 'new' });
      insertWorktree({ id: 'w2', path: '/b', repo_path: '/repo2', mode: 'new' });
      insertWorktree({ id: 'w3', path: '/c', repo_path: '/repo1', mode: 'new' });
      const results = listWorktreesByRepo('/repo1');
      expect(results.map((w) => w.id)).toEqual(expect.arrayContaining(['w1', 'w3']));
      expect(results.map((w) => w.id)).not.toContain('w2');
    });
  });

  // ─── listTrackedRepoPaths ─────────────────────────────────────────────────────

  describe('listTrackedRepoPaths', () => {
    it('returns distinct repo paths', () => {
      insertWorktree({ path: '/a', repo_path: '/repo1', mode: 'new' });
      insertWorktree({ path: '/b', repo_path: '/repo1', mode: 'new' }); // duplicate
      insertWorktree({ path: '/c', repo_path: '/repo2', mode: 'new' });
      const paths = listTrackedRepoPaths().map((r) => r.repo_path);
      // Should have exactly 2 distinct paths
      expect(new Set(paths).size).toBe(2);
    });
  });

  // ─── listTasksForWorktree ─────────────────────────────────────────────────────

  describe('listTasksForWorktree', () => {
    it('returns tasks referencing the worktree', () => {
      const wtId = insertWorktree({ path: '/p', mode: 'new' });
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, worktree_id)
         VALUES ('t1', 'A', '', 'idle', 'backlog', ?)`,
      ).run(wtId);
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, worktree_id)
         VALUES ('t2', 'B', '', 'running', 'in_progress', ?)`,
      ).run(wtId);
      const tasks = listTasksForWorktree(wtId);
      expect(tasks.map((t) => t.id)).toEqual(expect.arrayContaining(['t1', 't2']));
    });

    it('returns empty array when no tasks reference the worktree', () => {
      const wtId = insertWorktree({ path: '/p', mode: 'new' });
      expect(listTasksForWorktree(wtId)).toHaveLength(0);
    });
  });

  // ─── updateWorktreeFields dynamic SET ────────────────────────────────────────

  describe('updateWorktreeFields', () => {
    it('updates specified fields', () => {
      const id = insertWorktree({ path: '/old', mode: 'new' });
      updateWorktreeFields(id, { path: '/new', repo_path: '/repo' });
      const wt = getWorktree(id);
      expect(wt!.path).toBe('/new');
      expect(wt!.repo_path).toBe('/repo');
    });

    it('rejects non-allowlisted column', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      expect(() => updateWorktreeFields(id, { bad_col: 'x' })).toThrow(/allowlist/);
    });

    it('sets last_used_at when touchUsed=true', () => {
      const id = insertWorktree({ path: '', mode: 'new' });
      // last_used_at starts null
      const before = getWorktree(id);
      expect(before!.last_used_at).toBeNull();
      updateWorktreeFields(id, { path: '/updated' }, true);
      const after = getWorktree(id);
      expect(after!.last_used_at).not.toBeNull();
    });

    it('is a no-op for empty patch without touchUsed', () => {
      const id = insertWorktree({ path: '/p', mode: 'new' });
      expect(() => updateWorktreeFields(id, {})).not.toThrow();
    });
  });
});
