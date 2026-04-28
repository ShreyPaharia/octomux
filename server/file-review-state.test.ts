import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setReviewed, clearReviewed, listReviewState } from './file-review-state.js';
import { createTestDb, insertTask } from './test-helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';

describe('file_review_state DAO', () => {
  beforeEach(() => {
    const db = createTestDb();
    // FK: file_review_state.task_id -> tasks.id (PRAGMA foreign_keys=ON in initDb).
    insertTask(db, { id: 'task1', worktree: null });
    insertTask(db, { id: 'task2', worktree: null });
    vi.mocked(execFile).mockReset();
  });

  describe('setReviewed', () => {
    it('inserts a new row keyed by (task_id, file_path)', () => {
      setReviewed('task1', 'src/foo.ts', 'sha-at-click');
      const rows = listReviewState('task1');
      expect(rows).toEqual([
        expect.objectContaining({
          task_id: 'task1',
          file_path: 'src/foo.ts',
          reviewed_at_commit: 'sha-at-click',
        }),
      ]);
    });

    it('upserts on re-click with new commit sha', () => {
      setReviewed('task1', 'src/foo.ts', 'old-sha');
      setReviewed('task1', 'src/foo.ts', 'new-sha');
      const rows = listReviewState('task1');
      expect(rows).toHaveLength(1);
      expect(rows[0].reviewed_at_commit).toBe('new-sha');
    });
  });

  describe('clearReviewed', () => {
    it('removes the row', () => {
      setReviewed('task1', 'src/foo.ts', 'sha1');
      clearReviewed('task1', 'src/foo.ts');
      expect(listReviewState('task1')).toEqual([]);
    });

    it('is idempotent on missing row', () => {
      expect(() => clearReviewed('task1', 'src/foo.ts')).not.toThrow();
    });
  });

  describe('listReviewState', () => {
    it('returns only the requested task_id', () => {
      setReviewed('task1', 'src/a.ts', 'sha1');
      setReviewed('task2', 'src/b.ts', 'sha2');
      const t1 = listReviewState('task1');
      expect(t1.map((r) => r.file_path)).toEqual(['src/a.ts']);
    });
  });
});
