import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTestTask, execFileOk } from './test-helpers.js';
import { getDb } from './db.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';

vi.mock('./task-runner.js', () => ({
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

const { startTask } = await import('./task-runner.js');

describe('POST /api/tasks/:taskId/review', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
    vi.mocked(execFile).mockImplementation(
      execFileOk('headsha1111111111111111111111111111111111\n') as unknown as typeof execFile,
    );
    vi.mocked(startTask).mockResolvedValue(undefined);
  });

  it('creates a review task for a non-PR source (manual pre-PR mode)', async () => {
    insertTestTask({
      id: 'src1',
      repo_path: '/repos/foo',
      branch: 'agents/src1',
      base_branch: 'main',
      base_sha: 'basesha0000000000000000000000000000000000',
      worktree: '/wt/src1',
      runtime_state: 'running',
      pr_url: null,
      pr_number: null,
    });

    const res = await request(app).post('/api/tasks/src1/review').send();

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('created');
    expect(typeof res.body.id).toBe('string');

    const review = getDb()
      .prepare(
        `SELECT t.id, t.source, t.pr_url, t.pr_number, t.pr_head_sha, t.review_of_task_id,
                t.initial_prompt, w.branch, w.base_branch, w.repo_path
           FROM tasks t INNER JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.id = ?`,
      )
      .get(res.body.id) as Record<string, unknown> | undefined;

    expect(review).toBeDefined();
    expect(review!.source).toBe('auto_review');
    expect(review!.pr_url).toBeNull();
    expect(review!.pr_number).toBeNull();
    expect(review!.pr_head_sha).toBe('headsha1111111111111111111111111111111111');
    expect(review!.review_of_task_id).toBe('src1');
    expect(review!.repo_path).toBe('/repos/foo');
    expect(review!.branch).toMatch(/^review\/.+-task-src1$/);
    expect(review!.base_branch).toBe('main');
    expect(String(review!.initial_prompt)).toContain('/review-walkthrough');
    // The prompt must pin the review task's OWN id for --task, not the source id.
    expect(String(review!.initial_prompt)).toContain(`Review task id: ${res.body.id}`);
    expect(String(review!.initial_prompt)).toContain(`--task ${res.body.id}`);
    expect(String(review!.initial_prompt)).not.toContain('--task src1');
    // Source id stays in the prompt as context.
    expect(String(review!.initial_prompt)).toContain('id src1');
    expect(startTask).toHaveBeenCalled();
  });

  it('creates a review task for a PR-bearing source (carries pr fields through)', async () => {
    insertTestTask({
      id: 'src2',
      repo_path: '/repos/foo',
      branch: 'agents/src2',
      base_branch: 'main',
      worktree: '/wt/src2',
      runtime_state: 'running',
      pr_url: 'https://github.com/o/r/pull/42',
      pr_number: 42,
      pr_head_sha: 'prhead2222222222222222222222222222222222',
    });

    const res = await request(app).post('/api/tasks/src2/review').send();

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('created');

    const review = getDb()
      .prepare(
        `SELECT t.pr_url, t.pr_number, t.pr_head_sha, t.review_of_task_id,
                t.initial_prompt, w.branch
           FROM tasks t INNER JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.id = ?`,
      )
      .get(res.body.id) as Record<string, unknown> | undefined;

    expect(review).toBeDefined();
    expect(review!.pr_url).toBe('https://github.com/o/r/pull/42');
    expect(review!.pr_number).toBe(42);
    expect(review!.pr_head_sha).toBe('prhead2222222222222222222222222222222222');
    expect(review!.review_of_task_id).toBe('src2');
    expect(review!.branch).toMatch(/^review\/.+-pr-42$/);
    expect(String(review!.initial_prompt)).toContain('PR:');
    expect(String(review!.initial_prompt)).toContain('#42');
    expect(String(review!.initial_prompt)).toContain(`Review task id: ${res.body.id}`);
    expect(String(review!.initial_prompt)).toContain(`--task ${res.body.id}`);
  });

  it('returns existing review when manual review already exists for the source', async () => {
    insertTestTask({
      id: 'src3',
      repo_path: '/repos/foo',
      branch: 'agents/src3',
      base_branch: 'main',
      worktree: '/wt/src3',
      runtime_state: 'running',
    });

    const first = await request(app).post('/api/tasks/src3/review').send();
    expect(first.status).toBe(201);
    expect(first.body.action).toBe('created');

    vi.mocked(startTask).mockClear();
    const second = await request(app).post('/api/tasks/src3/review').send();
    expect(second.status).toBe(200);
    expect(second.body.action).toBe('existing');
    expect(second.body.id).toBe(first.body.id);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('returns existing review when one already exists for the PR (poller-created)', async () => {
    insertTestTask({
      id: 'src4',
      repo_path: '/repos/foo',
      branch: 'agents/src4',
      base_branch: 'main',
      worktree: '/wt/src4',
      runtime_state: 'running',
      pr_url: 'https://github.com/o/r/pull/7',
      pr_number: 7,
      pr_head_sha: 'sha7777',
    });
    // Poller-style row: same pr_number, source=auto_review, review_of_task_id NULL
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
       VALUES ('wt-poller', '', '/repos/foo', 'review/foo-pr-7', 'main', 'new', 'available')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks
         (id, title, description, runtime_state, workflow_status, pr_url, pr_number, pr_head_sha,
          initial_prompt, source, worktree_id)
       VALUES ('poller-rev', 'Review #7', '', 'idle', 'backlog',
               'https://github.com/o/r/pull/7', 7, 'sha7777', '/r-o', 'auto_review', 'wt-poller')`,
    ).run();

    const res = await request(app).post('/api/tasks/src4/review').send();
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('existing');
    expect(res.body.id).toBe('poller-rev');
  });

  it('returns 400 for a draft source (no branch yet)', async () => {
    insertTestTask({
      id: 'draft1',
      runtime_state: 'idle',
      worktree: null,
      branch: null,
      initial_prompt: null,
    });
    const res = await request(app).post('/api/tasks/draft1/review').send();
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/start/i);
  });

  it('returns 404 for a non-existent task', async () => {
    const res = await request(app).post('/api/tasks/missing/review').send();
    expect(res.status).toBe(404);
  });
});
