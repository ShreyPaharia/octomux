/**
 * Unit tests for the review-task service (SHR-176).
 *
 * Dedup lives in each caller, so these tests exercise the create TAIL:
 *  - createReviewTaskFromPr: insertReviewTask + broadcast(task:created) + startTask
 *  - createManualReview: PR vs pre-PR prompt selection, linked review_of_task_id
 *  - triggerReviewRun: start when idle, nudge the active agent when running
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTestTask, insertAgent } from '../test-helpers.js';
import { getDb } from '../db.js';
import { listRunsForWorkflow } from '../repositories/runs.js';
import type { Task } from '../types.js';

// ─── Mock side-effecting deps ───────────────────────────────────────────────

const mockStartTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockSendMessageToAgent = vi.fn().mockResolvedValue(undefined);
vi.mock('../tmux-input.js', () => ({
  sendMessageToAgent: vi.fn((...args: unknown[]) => mockSendMessageToAgent(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  createReviewTaskFromPr,
  createManualReview,
  triggerReviewRun,
  manualReRunNudge,
} from './review-service.js';

/** Let the fire-and-forget startTask().then() chain settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('review-service.createReviewTaskFromPr', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts an auto_review task, broadcasts task:created, and kicks startTask', async () => {
    const { id, task } = await createReviewTaskFromPr({
      repo_path: '/tmp/test-repo',
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
      pr_head_sha: 'head-sha-42',
      base_branch: 'main',
      title: 'Add feature',
      author: 'alice',
      requested_at: '2026-06-22T00:00:00.000Z',
    });

    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as {
      source: string;
      pr_number: number;
      pr_head_sha: string;
      title: string;
      initial_prompt: string;
    };
    expect(row.source).toBe('auto_review');
    expect(row.pr_number).toBe(42);
    expect(row.pr_head_sha).toBe('head-sha-42');
    expect(row.title).toBe('Review: Add feature (#42)');
    // Prompt pins the freshly-minted review-task id.
    expect(row.initial_prompt).toContain(id);

    expect(mockBroadcast).toHaveBeenCalledWith({
      type: 'task:created',
      payload: { taskId: id },
    });
    expect(mockStartTask).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(task.id).toBe(id);
  });

  it('broadcasts task:updated after startTask settles', async () => {
    const { id } = await createReviewTaskFromPr({
      repo_path: '/tmp/test-repo',
      pr_number: 7,
      pr_url: 'https://github.com/o/r/pull/7',
      pr_head_sha: 'sha7',
      base_branch: 'main',
      title: 'Fix',
      author: null,
      requested_at: '2026-06-22T00:00:00.000Z',
    });
    await flush();
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: id },
    });
  });

  it('records exactly one runs row linking the task with kind reviewer, trigger github', async () => {
    const { id } = await createReviewTaskFromPr({
      repo_path: '/tmp/test-repo',
      pr_number: 55,
      pr_url: 'https://github.com/o/r/pull/55',
      pr_head_sha: 'head-sha-55',
      base_branch: 'main',
      title: 'Add feature',
      author: 'alice',
      requested_at: '2026-06-22T00:00:00.000Z',
    });

    const rows = listRunsForWorkflow('reviewer');
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('github');
    expect(rows[0].task_id).toBe(id);
  });
});

describe('review-service.createManualReview', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('links the review to its source and uses the PR prompt when a PR exists', async () => {
    insertTestTask({ id: 'src-task-1' });
    const { id } = await createManualReview({
      source_task_id: 'src-task-1',
      source_title: 'Source work',
      repo_path: '/tmp/test-repo',
      branch: 'agents/src-task-1',
      base_branch: 'main',
      base_sha: 'base1',
      pr_head_sha: 'head1',
      pr_url: 'https://github.com/o/r/pull/9',
      pr_number: 9,
      requested_at: '2026-06-22T00:00:00.000Z',
    });

    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as {
      source: string;
      review_of_task_id: string;
      pr_number: number;
      initial_prompt: string;
    };
    expect(row.source).toBe('auto_review');
    expect(row.review_of_task_id).toBe('src-task-1');
    expect(row.pr_number).toBe(9);
    // PR prompt shape uses /review-walkthrough and references the PR number.
    expect(row.initial_prompt).toContain('(#9)');
    expect(mockStartTask).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it('uses the pre-PR (manual) prompt when the source has no PR', async () => {
    insertTestTask({ id: 'src-task-2' });
    const { id } = await createManualReview({
      source_task_id: 'src-task-2',
      source_title: 'Pre-PR work',
      repo_path: '/tmp/test-repo',
      branch: 'agents/src-task-2',
      base_branch: 'main',
      base_sha: 'base2',
      pr_head_sha: 'head2',
      pr_url: null,
      pr_number: null,
      requested_at: '2026-06-22T00:00:00.000Z',
    });

    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as {
      pr_number: number | null;
      review_of_task_id: string;
      initial_prompt: string;
    };
    expect(row.pr_number).toBeNull();
    expect(row.review_of_task_id).toBe('src-task-2');
    // Manual prompt references the source task id as context.
    expect(row.initial_prompt).toContain('src-task-2');
  });
});

describe('review-service.triggerReviewRun', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('(re)starts the task when it is not running', async () => {
    const task = insertTestTask({
      id: 'rev-1',
      runtime_state: 'idle',
      tmux_session: null,
    }) as Task;

    await triggerReviewRun(task);

    expect(mockStartTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev-1' }));
    expect(mockSendMessageToAgent).not.toHaveBeenCalled();
  });

  it('nudges the active agent when the task is already running', async () => {
    const task = insertTestTask({
      id: 'rev-2',
      runtime_state: 'running',
      tmux_session: 'octomux-agent-rev-2',
    }) as Task;
    insertAgent(getDb(), {
      id: 'agent-rev-2',
      task_id: 'rev-2',
      window_index: 1,
      status: 'running',
    });

    await triggerReviewRun(task);

    expect(mockStartTask).not.toHaveBeenCalled();
    expect(mockSendMessageToAgent).toHaveBeenCalledWith(
      'octomux-agent-rev-2',
      1,
      manualReRunNudge(),
    );
  });
});
