import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { listForRead, SHARED_LANE } from '../repositories/agent-learnings.js';

const mockFetch = vi.fn();
vi.mock('../github-client.js', () => ({
  fetchPrReviewComments: (...args: unknown[]) => mockFetch(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { ingestReviewComments } from './comment-feedback.js';

describe('ingestReviewComments', () => {
  let repoPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    createTestDb();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-comment-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('records a learning with all new comments and returns the count', async () => {
    mockFetch.mockResolvedValueOnce([
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
      { id: '2', body: 'This loop is O(n^2), consider a map.' },
    ]);

    const count = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(count).toBe(2);
    const rows = listForRead(repoPath, SHARED_LANE);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toContain('PR #42');
    expect(rows[0].lesson).toContain('server/foo.ts');
    expect(rows[0].lesson).toContain('Please add a null check here.');
    expect(rows[0].lesson).toContain('This loop is O(n^2), consider a map.');
    expect(rows[0].evidence).toContain('server/foo.ts');
  });

  it('uses the task lane when a task is supplied', async () => {
    mockFetch.mockResolvedValueOnce([{ id: '1', body: 'Please add a null check here.' }]);

    await ingestReviewComments({
      repoPath,
      prNumber: 42,
      task: { id: 't1', schedule_id: 'sched-9' },
    });

    expect(listForRead(repoPath, SHARED_LANE)).toHaveLength(0);
    expect(listForRead(repoPath, 'schedule:sched-9')).toHaveLength(1);
  });

  it('dedups by comment id on a second call — records nothing new', async () => {
    const comments = [
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
      { id: '2', body: 'This loop is O(n^2), consider a map.' },
    ];
    mockFetch.mockResolvedValueOnce(comments);
    await ingestReviewComments({ repoPath, prNumber: 42 });

    mockFetch.mockResolvedValueOnce(comments);
    const secondCount = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(secondCount).toBe(0);
    expect(listForRead(repoPath, SHARED_LANE)).toHaveLength(1);
  });

  it('records only the new comments when some ids were already ingested', async () => {
    mockFetch.mockResolvedValueOnce([
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
    ]);
    await ingestReviewComments({ repoPath, prNumber: 42 });

    mockFetch.mockResolvedValueOnce([
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
      { id: '3', body: 'New comment.' },
    ]);
    const count = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(count).toBe(1);
    const rows = listForRead(repoPath, SHARED_LANE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.lesson).join(' ')).toContain('New comment.');
  });

  it('returns 0 and records nothing when there are no comments', async () => {
    mockFetch.mockResolvedValueOnce([]);

    const count = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(count).toBe(0);
    expect(listForRead(repoPath, SHARED_LANE)).toHaveLength(0);
  });
});
