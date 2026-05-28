import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';

vi.mock('./inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn(),
}));

import { markStaleDrafts, autoResolvePublished } from './review-staleness.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';

const TASK_ID = 't1';

function seed(): ReturnType<typeof createTestDb> {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source, worktree_id)
     VALUES (?, 'x', '', 'idle', 'backlog', 'auto_review', 'wt1')`,
  ).run(TASK_ID);
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status, completed_at)
     VALUES ('r1', ?, 'sha-old', 'completed', datetime('now'))`,
  ).run(TASK_ID);
  return db;
}

describe('markStaleDrafts', () => {
  beforeEach(() => {
    vi.mocked(isAnchorOutdated).mockReset();
  });

  it('marks a draft stale when its anchor line moved', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'draft', 'r1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const row = db.prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('stale');
  });

  it('leaves a draft alone when its anchor is still present', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'draft', 'r1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(false);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const row = db.prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('draft');
  });

  it('does not touch published or rejected rows', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES
         ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1'),
         ('c2', ?, 'a.ts', 12, 'new', 'sha-old', 'b', 'rejected', 'r1')`,
    ).run(TASK_ID, TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const rows = db
      .prepare(`SELECT id, status FROM inline_comments WHERE task_id = ?`)
      .all(TASK_ID) as { id: string; status: string }[];
    expect(rows.find((r) => r.id === 'c1')?.status).toBe('published');
    expect(rows.find((r) => r.id === 'c2')?.status).toBe('rejected');
  });
});

describe('autoResolvePublished', () => {
  beforeEach(() => {
    vi.mocked(isAnchorOutdated).mockReset();
  });

  it('resolves a published comment when its line moved AND no re-flag exists in this run', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at, auto_resolved_reason FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null; auto_resolved_reason: string | null };
    expect(row.auto_resolved_at).not.toBeNull();
    expect(row.auto_resolved_reason).toMatch(/line range modified/);
  });

  it('skips when run contains a re_flag_of pointer at the published id', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id, re_flag_of)
       VALUES ('d1', ?, 'a.ts', 10, 'new', 'sha-new', 'still applies', 'draft', 'r2', 'p1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null };
    expect(row.auto_resolved_at).toBeNull();
  });

  it('skips when line range is unchanged', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(false);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null };
    expect(row.auto_resolved_at).toBeNull();
  });
});
