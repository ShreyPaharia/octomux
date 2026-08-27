import { describe, it, expect, beforeEach, vi } from '../../bun-test.js';

vi.mock('../../github-client.js', () => ({
  postPullRequestReview: vi.fn().mockResolvedValue({
    id: 9999,
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-9999',
  }),
  listReviewComments: vi.fn().mockResolvedValue([]),
  replyToReviewComment: vi.fn().mockResolvedValue(undefined),
  fetchPrReviewComments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn().mockResolvedValue(false),
  computeOutdated: vi.fn().mockResolvedValue(new Map()),
  splitLines: (s: string) => s.split('\n'),
}));

const { createTestDb } = await import('../../test-helpers.js');
const { getDb } = await import('../../db.js');

const { postPullRequestReview, listReviewComments, replyToReviewComment, fetchPrReviewComments } =
  await import('../../github-client.js');
const { isAnchorOutdated } = await import('../../inline-comments-outdated.js');
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
    vi.mocked(listReviewComments).mockResolvedValue([]);
    vi.mocked(replyToReviewComment).mockResolvedValue(undefined);
    vi.mocked(fetchPrReviewComments).mockResolvedValue([]);
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

  it('backfills github_comment_id from the posted review comments', async () => {
    vi.mocked(listReviewComments).mockResolvedValue([
      { id: 111, path: 'a.ts', body: 'issue here' },
      { id: 222, path: 'b.ts', body: 'another' },
    ]);
    await publishReview('t1', 'COMMENT', '');
    const rows = getDb()
      .prepare(`SELECT id, github_comment_id FROM inline_comments WHERE id IN ('c1','c2')`)
      .all() as any[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.github_comment_id]))).toEqual({
      c1: 111,
      c2: 222,
    });
  });

  describe('re-review publish: addressed threads', () => {
    /** Prior published comment marked `resolved` by the current run (r-new). */
    function seedResolvedPrior(opts: { githubCommentId?: number | null } = {}) {
      const db = getDb();
      db.prepare(
        `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at, completed_at)
         VALUES ('r-new', 't1', 'sha-head2', 'completed', datetime('now'), datetime('now'))`,
      ).run();
      db.prepare(`UPDATE tasks SET pr_head_sha = 'sha-head2' WHERE id = 't1'`).run();
      db.prepare(
        `INSERT INTO inline_comments
           (id, task_id, file_path, line, side, original_commit_sha, body, status, kind,
            github_comment_id, last_check_run_id, last_check_status)
         VALUES ('prior1', 't1', 'old.ts', 7, 'new', 'sha-head', 'old finding', 'published',
                 'comment', ?, 'r-new', 'resolved')`,
      ).run(opts.githubCommentId === undefined ? 555 : opts.githubCommentId);
    }

    it('replies "Addressed in <sha>" on threads the run marked resolved and stamps resolved_at', async () => {
      seedResolvedPrior();
      await publishReview('t1', 'COMMENT', '');
      expect(replyToReviewComment).toHaveBeenCalledOnce();
      const call = vi.mocked(replyToReviewComment).mock.calls[0][0];
      expect(call.comment_id).toBe(555);
      expect(call.body).toBe('Addressed in sha-head2.');
      const row = getDb()
        .prepare(`SELECT resolved_at, last_check_status FROM inline_comments WHERE id = 'prior1'`)
        .get() as any;
      expect(row.resolved_at).not.toBeNull();
      // check-previous stays the single status vocabulary.
      expect(row.last_check_status).toBe('resolved');
    });

    it('does not reply for still_applies or unchecked prior comments', async () => {
      seedResolvedPrior();
      getDb()
        .prepare(
          `UPDATE inline_comments SET last_check_status = 'still_applies' WHERE id = 'prior1'`,
        )
        .run();
      await publishReview('t1', 'COMMENT', '');
      expect(replyToReviewComment).not.toHaveBeenCalled();
    });

    it('falls back to matching PR comments by path+body when github_comment_id is null', async () => {
      seedResolvedPrior({ githubCommentId: null });
      vi.mocked(fetchPrReviewComments).mockResolvedValue([
        { id: '777', body: 'old finding', path: 'old.ts' },
      ]);
      await publishReview('t1', 'COMMENT', '');
      expect(vi.mocked(replyToReviewComment).mock.calls[0][0].comment_id).toBe(777);
    });

    it('a thread-reply failure never fails the publish', async () => {
      seedResolvedPrior();
      vi.mocked(replyToReviewComment).mockRejectedValue(new Error('gh exploded'));
      const result = await publishReview('t1', 'COMMENT', '');
      expect(result.comment_count).toBe(2);
      // Not stamped resolved — the next publish retries the reply.
      const row = getDb()
        .prepare(`SELECT resolved_at FROM inline_comments WHERE id = 'prior1'`)
        .get() as any;
      expect(row.resolved_at).toBeNull();
    });
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
