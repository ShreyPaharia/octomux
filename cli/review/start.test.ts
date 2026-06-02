import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runStart } from './start.js';

let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write);
});

function seedTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES ('wt1', '/tmp/wt', '/repos/foo', 'review/x', 'main', 'sha-base', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, source, worktree_id,
        pr_url, pr_number, pr_head_sha)
     VALUES
       ('t1', 'PR review', '', 'running', 'backlog', 'auto_review', 'wt1',
        'https://github.com/o/r/pull/1', 1, 'sha-head')`,
  ).run();
}

describe('octomux review start', () => {
  it('creates a review_run and prints JSON with run id, sha, prev review (null), learnings (empty)', async () => {
    const db = createTestDb();
    seedTask(db);
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.review_run_id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(out.pr_head_sha).toBe('sha-head');
    expect(out.base_sha).toBe('sha-base');
    expect(out.previous_review).toBeNull();
    expect(Array.isArray(out.learnings)).toBe(true);
    expect(out.learnings.length).toBe(0);
    expect(Array.isArray(out.instruction_files)).toBe(true);
  });

  it('reuses the current run if one is still running for the same sha', async () => {
    const db = createTestDb();
    seedTask(db);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status)
       VALUES ('r-existing', 't1', 'sha-head', 'running')`,
    ).run();
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.review_run_id).toBe('r-existing');
  });

  it('includes previous_review when a prior published review exists', async () => {
    const db = createTestDb();
    seedTask(db);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status, walkthrough, completed_at)
       VALUES ('r-old', 't1', 'sha-prev', 'completed', '{"global":{}}', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO published_reviews (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
       VALUES ('pr1', 't1', 1, 'https://x', 'sha-prev', 'COMMENT', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, published_review_id)
       VALUES ('c1', 't1', 'a.ts', 5, 'new', 'sha-prev', 'old', 'published', 'comment', 'pr1')`,
    ).run();
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.previous_review).not.toBeNull();
    expect(out.previous_review.head_sha).toBe('sha-prev');
    expect(out.previous_review.comments[0].id).toBe('c1');
  });

  it('exits 2 when --task is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(runStart([])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/--task is required/);
    exitSpy.mockRestore();
  });

  it('exits 2 when --task points at a source task rather than the review task', async () => {
    const db = createTestDb();
    // A regular (non-review) task — source is null, like the task being reviewed.
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
       VALUES ('wtDev', '/tmp/dev', '/repos/foo', 'feat/x', 'main', 'sha-base', 'new', 'available')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks
         (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_head_sha)
       VALUES
         ('dev1', 'Dev task', '', 'running', 'backlog', NULL, 'wtDev', 'sha-head')`,
    ).run();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(runStart(['--task', 'dev1'])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/review task id/i);
    exitSpy.mockRestore();
  });
});
