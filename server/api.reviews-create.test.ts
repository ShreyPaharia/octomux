import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, execFileOk, execFileFail } from './test-helpers.js';
import { getDb } from './db.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';

vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn().mockResolvedValue(undefined),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  softDeleteTask: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

const { startTask } = await import('./task-engine/index.js');

const OPEN_PR_JSON = JSON.stringify({
  title: 'Add cool feature',
  headRefOid: 'abc123def456abc123def456abc123def456abc1',
  baseRefName: 'main',
  author: { login: 'testuser' },
  state: 'OPEN',
  url: 'https://github.com/owner/myrepo/pull/42',
});

const CLOSED_PR_JSON = JSON.stringify({
  title: 'Old feature',
  headRefOid: 'deadbeef',
  baseRefName: 'main',
  author: { login: 'testuser' },
  state: 'CLOSED',
  url: 'https://github.com/owner/myrepo/pull/99',
});

describe('POST /api/reviews', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
    vi.mocked(startTask).mockResolvedValue(undefined);
  });

  it('returns 400 for invalid pr_url', async () => {
    vi.mocked(execFile).mockImplementation(execFileOk('') as unknown as typeof execFile);
    const res = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://not-github.com/foo/bar' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid pr_url/i);
  });

  it('returns 400 for missing pr_url', async () => {
    vi.mocked(execFile).mockImplementation(execFileOk('') as unknown as typeof execFile);
    const res = await request(app).post('/api/reviews').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid pr_url/i);
  });

  it('creates a review task for an OPEN PR with explicit repo_path → 201', async () => {
    // Mock gh pr view returning an OPEN PR
    vi.mocked(execFile).mockImplementation(execFileOk(OPEN_PR_JSON) as unknown as typeof execFile);

    const res = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.reused).toBe(false);

    const db = getDb();
    const review = db
      .prepare(
        `SELECT t.id, t.source, t.pr_url, t.pr_number, t.pr_head_sha,
                t.initial_prompt, w.branch, w.base_branch, w.repo_path
           FROM tasks t INNER JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.id = ?`,
      )
      .get(res.body.id) as Record<string, unknown> | undefined;

    expect(review).toBeDefined();
    expect(review!.source).toBe('auto_review');
    expect(review!.pr_number).toBe(42);
    expect(review!.pr_url).toBe('https://github.com/owner/myrepo/pull/42');
    expect(review!.pr_head_sha).toBe('abc123def456abc123def456abc123def456abc1');
    expect(review!.repo_path).toBe('/repos/myrepo');
    expect(review!.branch).toMatch(/^review\/.+-pr-42$/);
    expect(review!.base_branch).toBe('main');
    expect(String(review!.initial_prompt)).toContain('/octomux:review-walkthrough');
    expect(String(review!.initial_prompt)).toContain(`Review task id: ${res.body.id}`);
    expect(String(review!.initial_prompt)).toContain(`--task ${res.body.id}`);
    expect(startTask).toHaveBeenCalled();
  });

  it('dedup: second POST for same repo+PR returns 200 {reused:true} and no duplicate task', async () => {
    vi.mocked(execFile).mockImplementation(execFileOk(OPEN_PR_JSON) as unknown as typeof execFile);

    const first = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });

    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);

    vi.mocked(startTask).mockClear();

    const second = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });

    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(startTask).not.toHaveBeenCalled();

    // Confirm only one task was created
    const db = getDb();
    const count = db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE pr_number = 42 AND source = 'auto_review'`)
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('returns 400 when PR is CLOSED', async () => {
    vi.mocked(execFile).mockImplementation(
      execFileOk(CLOSED_PR_JSON) as unknown as typeof execFile,
    );

    const res = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/99', repo_path: '/repos/myrepo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/CLOSED/);
  });

  it('returns 400 when gh CLI fails', async () => {
    vi.mocked(execFile).mockImplementation(
      execFileFail('gh: not found') as unknown as typeof execFile,
    );

    const res = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/failed to fetch PR metadata/i);
  });

  it('returns 400 when repo cannot be resolved from tracked repos', async () => {
    // execFile for git remote get-url fails → no match
    vi.mocked(execFile).mockImplementation(
      execFileFail('not a git repo') as unknown as typeof execFile,
    );

    const res = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/could not resolve a local repo/i);
  });

  it('dedup: existing error-state task is not reused, new task created', async () => {
    vi.mocked(execFile).mockImplementation(execFileOk(OPEN_PR_JSON) as unknown as typeof execFile);

    // Create first task
    const first = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });
    expect(first.status).toBe(201);

    // Mark first task as error
    const db = getDb();
    db.prepare(`UPDATE tasks SET runtime_state = 'error' WHERE id = ?`).run(first.body.id);

    vi.mocked(startTask).mockClear();

    // Second POST should create a new task since the only existing one is in error state
    const second = await request(app)
      .post('/api/reviews')
      .send({ pr_url: 'https://github.com/owner/myrepo/pull/42', repo_path: '/repos/myrepo' });
    expect(second.status).toBe(201);
    expect(second.body.reused).toBe(false);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
