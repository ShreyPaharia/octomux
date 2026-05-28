import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { getDb } from './db.js';

vi.mock('./github-client.js', () => ({
  postPullRequestReview: vi.fn().mockResolvedValue({
    id: 9999,
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-9999',
  }),
}));

vi.mock('./inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn().mockResolvedValue(false),
  computeOutdated: vi.fn().mockResolvedValue(new Map()),
  splitLines: (s: string) => s.split('\n'),
}));

const { postPullRequestReview } = await import('./github-client.js');
const { isAnchorOutdated } = await import('./inline-comments-outdated.js');
const { publishReview } = await import('./publish-review.js');

function seed() {
  const db = getDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, source, worktree_id,
        pr_url, pr_number, pr_head_sha)
     VALUES
       ('t1', 'PR review', '', 'idle', 'backlog', 'auto_review', 'wt1',
        'https://github.com/octomux/demo/pull/42', 42, 'sha-head')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status)
     VALUES ('r1', 't1', 'sha-head', 'completed')`,
  ).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, review_run_id)
     VALUES
       ('c1', 't1', 'a.ts', 1, 'new', 'sha-head', 'issue here', 'accepted', 'comment', 'r1'),
       ('c2', 't1', 'b.ts', 2, 'new', 'sha-head', 'another', 'accepted', 'comment', 'r1'),
       ('c3', 't1', 'c.ts', 3, 'new', 'sha-head', 'still draft', 'draft', 'comment', 'r1')`,
  ).run();
}

describe('publishReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTestDb();
    seed();
    vi.mocked(isAnchorOutdated).mockResolvedValue(false);
    vi.mocked(postPullRequestReview).mockResolvedValue({
      id: 9999,
      html_url: 'https://github.com/o/r/pull/1#pullrequestreview-9999',
    });
  });

  it('calls postPullRequestReview with accepted comments', async () => {
    const result = await publishReview('t1', 'COMMENT', 'LGTM');
    expect(postPullRequestReview).toHaveBeenCalledOnce();
    const call = vi.mocked(postPullRequestReview).mock.calls[0][0];
    expect(call.owner).toBe('octomux');
    expect(call.repo).toBe('demo');
    expect(call.pull_number).toBe(42);
    expect(call.event).toBe('COMMENT');
    expect(call.body).toBe('LGTM');
    expect(call.comments).toHaveLength(2); // c1 and c2
    expect(result.comment_count).toBe(2);
  });

  it('creates a published_reviews row', async () => {
    await publishReview('t1', 'APPROVE', '');
    const rows = getDb()
      .prepare(`SELECT * FROM published_reviews WHERE task_id = 't1'`)
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('APPROVE');
    expect(rows[0].github_review_id).toBe(9999);
  });

  it('flips accepted comments to published status', async () => {
    await publishReview('t1', 'COMMENT', '');
    const published = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE status = 'published'`)
      .all() as any[];
    expect(published.map((r: any) => r.id).sort()).toEqual(['c1', 'c2']);
    // draft stays draft
    const draft = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE status = 'draft'`)
      .all() as any[];
    expect(draft.map((r: any) => r.id)).toEqual(['c3']);
  });

  it('flips stale comments to stale status', async () => {
    vi.mocked(isAnchorOutdated).mockImplementation(async (input) => {
      return input.file === 'a.ts'; // only c1 is stale
    });
    const result = await publishReview('t1', 'COMMENT', '');
    expect(result.comment_count).toBe(1); // only c2 published
    const stale = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE status = 'stale'`)
      .all() as any[];
    expect(stale.map((r: any) => r.id)).toEqual(['c1']);
  });

  it('throws when no accepted comments exist', async () => {
    getDb().prepare(`UPDATE inline_comments SET status = 'draft' WHERE task_id = 't1'`).run();
    await expect(publishReview('t1', 'COMMENT', '')).rejects.toThrow('No accepted comments');
  });

  it('builds suggestion block for kind=suggestion', async () => {
    getDb()
      .prepare(
        `UPDATE inline_comments SET kind = 'suggestion', suggested_code = 'const x = 1;' WHERE id = 'c1'`,
      )
      .run();
    await publishReview('t1', 'COMMENT', '');
    const call = vi.mocked(postPullRequestReview).mock.calls[0][0];
    const c1Body = call.comments.find((c: any) => c.path === 'a.ts')?.body ?? '';
    expect(c1Body).toContain('```suggestion');
    expect(c1Body).toContain('const x = 1;');
  });
});
