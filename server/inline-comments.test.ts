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

describe('inline-comments — orchestrator fields', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t1', 'x', '', 'idle', 'backlog', 'auto_review')`,
    ).run();
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha1')`,
    ).run();
  });

  it('inserts a kind=comment draft with bucket+severity+review_run_id', () => {
    const row = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 10,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'consider memoizing',
      kind: 'comment',
      severity: 'suggestion',
      bucket: 'actionable',
      review_run_id: 'r1',
    });
    expect(row.kind).toBe('comment');
    expect(row.bucket).toBe('actionable');
    expect(row.severity).toBe('suggestion');
    expect(row.review_run_id).toBe('r1');
    expect(row.status).toBe('draft');
  });

  it('inserts a kind=suggestion draft with existing_code + suggested_code', () => {
    const row = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 12,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'use Object.fromEntries',
      kind: 'suggestion',
      severity: 'nit',
      bucket: 'actionable',
      review_run_id: 'r1',
      existing_code: 'return data.reduce(...)',
      suggested_code: 'return Object.fromEntries(data);',
    });
    expect(row.kind).toBe('suggestion');
    expect(row.existing_code).toBe('return data.reduce(...)');
    expect(row.suggested_code).toBe('return Object.fromEntries(data);');
  });

  it('inserts a re_flag_of pointer when set', () => {
    const original = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 1,
      side: 'new',
      original_commit_sha: 'sha0',
      body: 'first',
      review_run_id: 'r1',
    });
    const reflag = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 1,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'still applies',
      review_run_id: 'r1',
      re_flag_of: original.id,
    });
    expect(reflag.re_flag_of).toBe(original.id);
  });
});
