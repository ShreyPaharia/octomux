import { describe, it, expect, beforeEach } from 'vitest';
import {
  addComment,
  listComments,
  getComment,
  resolveComment,
  unresolveComment,
  updateCommentBody,
  deleteComment,
} from './inline-comments.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { getDb } from './db.js';

describe('inline_comments DAO', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task1', worktree: null });
    insertTask(db, { id: 'task2', worktree: null });
    insertAgent(db, { id: 'agent1', task_id: 'task1' });
  });

  describe('addComment', () => {
    it.each([
      ['minimal fields', { side: 'new' as const, agent_id: undefined as string | undefined }],
      ['with agent_id', { side: 'new' as const, agent_id: 'agent1' as string | undefined }],
      ["side 'old'", { side: 'old' as const, agent_id: undefined as string | undefined }],
      ["side 'new'", { side: 'new' as const, agent_id: undefined as string | undefined }],
    ])('inserts a row with %s', (_name, partial) => {
      const row = addComment({
        task_id: 'task1',
        file_path: 'src/foo.ts',
        line: 10,
        side: partial.side,
        original_commit_sha: 'sha1',
        body: 'hello',
        agent_id: partial.agent_id,
      });
      expect(row.id).toBeTruthy();
      expect(row.task_id).toBe('task1');
      expect(row.line).toBe(10);
      expect(row.side).toBe(partial.side);
      expect(row.body).toBe('hello');
      expect(row.agent_id).toBe(partial.agent_id ?? null);
      expect(row.resolved_at).toBeNull();
    });

    it('rejects invalid side via SQL CHECK', () => {
      expect(() =>
        addComment({
          task_id: 'task1',
          file_path: 'src/foo.ts',
          line: 1,
          // @ts-expect-error testing invalid side
          side: 'middle',
          original_commit_sha: 'sha',
          body: 'x',
        }),
      ).toThrow();
    });
  });

  describe('listComments', () => {
    it('returns only matching task_id, ordered by created_at', () => {
      addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'one',
      });
      addComment({
        task_id: 'task2',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'other-task',
      });
      const t1 = listComments('task1');
      expect(t1.map((r) => r.body)).toEqual(['one']);
    });

    it('filters by file', () => {
      addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'A',
      });
      addComment({
        task_id: 'task1',
        file_path: 'b.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'B',
      });
      const rows = listComments('task1', { file: 'b.ts' });
      expect(rows.map((r) => r.body)).toEqual(['B']);
    });
  });

  describe('resolve / unresolve', () => {
    it('toggles resolved_at idempotently', () => {
      const row = addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'x',
      });
      const r1 = resolveComment(row.id);
      expect(r1?.resolved_at).toBeTruthy();
      // Calling resolve again preserves the original timestamp.
      const r2 = resolveComment(row.id);
      expect(r2?.resolved_at).toBe(r1?.resolved_at);
      const u = unresolveComment(row.id);
      expect(u?.resolved_at).toBeNull();
    });
  });

  describe('updateCommentBody', () => {
    it('updates body and returns the row', () => {
      const row = addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'old',
      });
      const updated = updateCommentBody(row.id, 'new body');
      expect(updated?.body).toBe('new body');
    });

    it('returns null for missing id', () => {
      expect(updateCommentBody('does-not-exist', 'x')).toBeNull();
    });
  });

  describe('deleteComment', () => {
    it('returns true on first delete and false on the second', () => {
      const row = addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'x',
      });
      expect(deleteComment(row.id)).toBe(true);
      expect(getComment(row.id)).toBeNull();
      expect(deleteComment(row.id)).toBe(false);
    });

    it('cascades when the task is deleted', () => {
      const row = addComment({
        task_id: 'task1',
        file_path: 'a.ts',
        line: 1,
        side: 'new',
        original_commit_sha: 's',
        body: 'x',
      });
      getDb().prepare(`DELETE FROM tasks WHERE id = ?`).run('task1');
      expect(getComment(row.id)).toBeNull();
    });
  });
});
