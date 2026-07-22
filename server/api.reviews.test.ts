import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTestTask } from './test-helpers.js';
import { getDb } from './db.js';

// Minimal mocks so createApp doesn't fail on missing native deps
vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn().mockResolvedValue(undefined),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

vi.mock('./tmux-input.js', () => ({
  sendMessageToAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./workflows/reviewer/publish-review.js', () => ({
  publishReview: vi.fn().mockResolvedValue({ github_review_url: 'https://github.com/test' }),
}));

const { startTask } = await import('./task-engine/index.js');
const { sendMessageToAgent } = await import('./tmux-input.js');

// Seed a review task with a run and comments
function seedReviewTask() {
  const db = getDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt-r1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_url, pr_number, pr_head_sha, tmux_session)
     VALUES
       ('task-rev1', 'PR review', '', 'idle', 'backlog', 'auto_review', 'wt-r1',
        'https://github.com/o/r/pull/1', 1, 'sha-head', 'tmux-rev1')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, walkthrough, status, completed_at)
     VALUES ('run-r1', 'task-rev1', 'sha-head', '{"global":{"risk":"low"}}', 'completed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, review_run_id)
     VALUES
       ('cc1', 'task-rev1', 'a.ts', 1, 'new', 'sha-head', 'look here', 'draft', 'comment', 'run-r1'),
       ('cc2', 'task-rev1', 'a.ts', 2, 'new', 'sha-head', 'accepted one', 'accepted', 'comment', 'run-r1')`,
  ).run();
}

describe('GET /api/reviews', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    seedReviewTask();
    app = createApp();
  });

  it('returns list of review inbox rows', async () => {
    const res = await request(app).get('/api/reviews');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].task_id).toBe('task-rev1');
    expect(res.body[0].draft_count).toBe(1);
    expect(res.body[0].accepted_count).toBe(1);
  });

  it('excludes non-auto_review tasks', async () => {
    insertTestTask({ id: 'regular-t', source: null });
    const res = await request(app).get('/api/reviews');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // only the seeded review task
  });
});

describe('GET /api/reviews/:id', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    seedReviewTask();
    app = createApp();
  });

  it('returns full review detail with all comments (active + history for Discussion)', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, review_run_id)
       VALUES ('cc3', 'task-rev1', 'a.ts', 3, 'new', 'sha-head', 'rejected', 'rejected', 'comment', 'run-r1')`,
    ).run();
    const res = await request(app).get('/api/reviews/task-rev1');
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe('task-rev1');
    expect(res.body.latest_run.id).toBe('run-r1');
    // The rejected comment is included so the Discussion tab can render history.
    expect(res.body.comments).toHaveLength(3);
    expect(res.body.comments.some((c: { status: string }) => c.status === 'rejected')).toBe(true);
    expect(res.body.published_history).toEqual([]);
  });

  it('returns 404 for unknown review', async () => {
    const res = await request(app).get('/api/reviews/unknown');
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-auto_review task', async () => {
    insertTestTask({ id: 'regular-t', source: null });
    const res = await request(app).get('/api/reviews/regular-t');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/tasks/:id/review-runs/:rid/walkthrough', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    seedReviewTask();
    app = createApp();
  });

  it('deep-merges walkthrough JSON', async () => {
    const res = await request(app)
      .patch('/api/tasks/task-rev1/review-runs/run-r1/walkthrough')
      .send({ global: { risk: 'high' }, newKey: 'newVal' });
    expect(res.status).toBe(200);
    const wt = JSON.parse(res.body.walkthrough);
    expect(wt.global.risk).toBe('high');
    expect(wt.newKey).toBe('newVal');
  });

  it('returns 404 for unknown run', async () => {
    const res = await request(app)
      .patch('/api/tasks/task-rev1/review-runs/no-such-run/walkthrough')
      .send({ global: {} });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app)
      .patch('/api/tasks/no-task/review-runs/run-r1/walkthrough')
      .send({ global: {} });
    expect(res.status).toBe(404);
  });

  it('returns 409 if review already published for this head SHA', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO published_reviews (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
       VALUES ('pub1', 'task-rev1', 12345, 'https://gh/r', 'sha-head', 'COMMENT', 1)`,
    ).run();
    const res = await request(app)
      .patch('/api/tasks/task-rev1/review-runs/run-r1/walkthrough')
      .send({ global: {} });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/tasks/:id/review-runs', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    seedReviewTask();
    app = createApp();
    vi.mocked(startTask).mockResolvedValue(undefined);
    vi.mocked(sendMessageToAgent).mockResolvedValue(undefined);
  });

  it('calls startTask when task is not running', async () => {
    const res = await request(app).post('/api/tasks/task-rev1/review-runs').send();
    expect(res.status).toBe(202);
    expect(startTask).toHaveBeenCalled();
  });

  it('nudges agent when task is already running', async () => {
    const db = getDb();
    db.prepare(`UPDATE tasks SET runtime_state = 'running' WHERE id = 'task-rev1'`).run();
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, status, hook_token)
       VALUES ('ag1', 'task-rev1', 0, 'Agent', 'running', '')`,
    ).run();
    const res = await request(app).post('/api/tasks/task-rev1/review-runs').send();
    expect(res.status).toBe(202);
    expect(sendMessageToAgent).toHaveBeenCalledWith('tmux-rev1', 0, expect.any(String));
  });

  it('returns 409 if a run is already running', async () => {
    const db = getDb();
    // Use a different sha to avoid UNIQUE constraint with the 'completed' run for sha-head
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status)
       VALUES ('run-active', 'task-rev1', 'sha-new', 'running')`,
    ).run();
    const res = await request(app).post('/api/tasks/task-rev1/review-runs').send();
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app).post('/api/tasks/unknown/review-runs').send();
    expect(res.status).toBe(404);
  });
});

describe('GET /api/repos/:repoPath/learnings', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
    const db = getDb();
    db.prepare(
      `INSERT INTO review_learnings (id, repo_path, why)
       VALUES ('l1', '/repos/foo', 'avoid bare exceptions')`,
    ).run();
  });

  it('returns learnings for a repo', async () => {
    const res = await request(app).get('/api/repos/%2Frepos%2Ffoo/learnings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].why).toBe('avoid bare exceptions');
  });

  it('returns empty array for unknown repo', async () => {
    const res = await request(app).get('/api/repos/%2Funknown/learnings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /api/learnings/:id', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    app = createApp();
    const db = getDb();
    db.prepare(
      `INSERT INTO review_learnings (id, repo_path, why)
       VALUES ('l1', '/repos/foo', 'avoid bare exceptions')`,
    ).run();
  });

  it('deletes a learning and returns 204', async () => {
    const res = await request(app).delete('/api/learnings/l1');
    expect(res.status).toBe(204);
    const remaining = getDb().prepare(`SELECT * FROM review_learnings WHERE id = 'l1'`).all();
    expect(remaining).toHaveLength(0);
  });

  it('returns 204 even for non-existent id (idempotent)', async () => {
    const res = await request(app).delete('/api/learnings/not-exist');
    expect(res.status).toBe(204);
  });
});
