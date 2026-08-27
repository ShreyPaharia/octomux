import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';
import type Database from '../sqlite.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../events.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./github-repo.js', () => ({
  repoNameWithOwner: vi.fn().mockResolvedValue('org/repo'),
}));

vi.mock('../tmux-input.js', () => ({
  sendMessageToAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../compute/index.js', () => ({
  sessionFor: vi.fn().mockResolvedValue({}),
  localSession: {},
}));

vi.mock('../task-engine/index.js', () => ({
  resumeTask: vi.fn().mockResolvedValue(undefined),
  softDeleteTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../task-engine/git.js', () => ({
  checkoutRef: vi.fn().mockResolvedValue(undefined),
  fetchOriginQuiet: vi.fn().mockResolvedValue(undefined),
}));

const { createTestDb, insertTask, insertAgent, findCallback } = await import('../test-helpers.js');
const { execFile } = await import('child_process');
const { sendMessageToAgent } = await import('../tmux-input.js');
const { resumeTask } = await import('../task-engine/index.js');
const { pollReviewerRequests } = await import('./reviewer-requests.js');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const REPO = '/repos/foo';
const OWNER = 'reviewer-bot';

/** gh graphql: one open PR (#42) with review requested from the owner. */
function mockGhSearch(headRefOid: string) {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = findCallback(...rest);
    if (!cb) return undefined as never;
    if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'graphql') {
      cb(null, {
        stdout: JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  number: 42,
                  title: 'Fix things',
                  url: 'https://github.com/org/repo/pull/42',
                  author: { login: 'author' },
                  headRefOid,
                  headRefName: 'feat/x',
                  baseRefName: 'main',
                  repository: { nameWithOwner: 'org/repo' },
                  reviewRequests: {
                    nodes: [{ requestedReviewer: { __typename: 'User', login: OWNER } }],
                  },
                  timelineItems: { nodes: [] },
                },
              ],
            },
          },
        }),
        stderr: '',
      });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
    return undefined as never;
  }) as unknown as typeof execFile);
}

function seedReviewTask(db: Database, opts: { runtimeState?: string } = {}): void {
  insertTask(db, {
    id: 't1',
    title: 'Review: Fix things (#42)',
    runtime_state: (opts.runtimeState ?? 'running') as never,
    workflow_status: 'in_progress',
    source: 'auto_review',
    repo_path: REPO,
    worktree: `${REPO}/.worktrees/t1`,
    tmux_session: 'octomux-agent-t1',
    pr_url: 'https://github.com/org/repo/pull/42',
    pr_number: 42,
    pr_head_sha: 'old-sha',
  });
  insertAgent(db, { id: 'a1', task_id: 't1', window_index: 1, status: 'working' as never });
}

/** Completed review_run + published review at old-sha — a published pipeline round. */
function seedPublishedRun(db: Database): void {
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status, completed_at)
     VALUES ('r1', 't1', 'old-sha', 'completed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO published_reviews
       (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
     VALUES ('pub1', 't1', 1, 'https://x', 'old-sha', 'COMMENT', 1)`,
  ).run();
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('pollReviewerRequests re-review', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    process.env.OCTOMUX_GITHUB_LOGIN = OWNER;
  });

  afterEach(() => {
    delete process.env.OCTOMUX_GITHUB_LOGIN;
  });

  it('nudges a running pipeline task through the review CLI when the head advances after a published run', async () => {
    seedReviewTask(db);
    seedPublishedRun(db);
    mockGhSearch('new-sha');

    await pollReviewerRequests();

    expect(sendMessageToAgent).toHaveBeenCalledOnce();
    const message = vi.mocked(sendMessageToAgent).mock.calls[0][3] as string;
    expect(message).toContain('octomux review start --task t1');
    expect(message).toContain('check-previous');
    expect(message).toContain('last_reviewed_sha');
    expect(message).toContain('human-gated');
    expect(message).not.toContain('/review-artifact');

    // Baseline advanced so the next poll cycle doesn't re-trigger.
    const row = db.prepare(`SELECT pr_head_sha FROM tasks WHERE id = 't1'`).get() as {
      pr_head_sha: string;
    };
    expect(row.pr_head_sha).toBe('new-sha');
  });

  it('keeps the artifact-flow nudge for tasks with no review_runs', async () => {
    seedReviewTask(db);
    mockGhSearch('new-sha');

    await pollReviewerRequests();

    expect(sendMessageToAgent).toHaveBeenCalledOnce();
    const message = vi.mocked(sendMessageToAgent).mock.calls[0][3] as string;
    expect(message).toContain('/review-artifact');
    expect(message).not.toContain('octomux review start');
  });

  it('resumes an idle pipeline task with the pipeline re-review prompt', async () => {
    seedReviewTask(db, { runtimeState: 'idle' });
    seedPublishedRun(db);
    mockGhSearch('new-sha');

    await pollReviewerRequests();

    expect(resumeTask).toHaveBeenCalledOnce();
    const opts = vi.mocked(resumeTask).mock.calls[0][1] as { prompt: string };
    expect(opts.prompt).toContain('octomux review start --task t1');
    expect(opts.prompt).toContain('check-previous');
  });

  it('does not trigger anything when the head is unchanged and no re-request happened', async () => {
    seedReviewTask(db);
    seedPublishedRun(db);
    mockGhSearch('old-sha');

    await pollReviewerRequests();

    expect(sendMessageToAgent).not.toHaveBeenCalled();
    expect(resumeTask).not.toHaveBeenCalled();
  });
});
