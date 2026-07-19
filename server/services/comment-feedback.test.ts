import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-comment-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function readPlaybook(): string {
    return fs.readFileSync(path.join(repoPath, '.octomux', 'loop-playbook.md'), 'utf-8');
  }

  it('appends one bounded entry with all new comments and returns the count', async () => {
    mockFetch.mockResolvedValueOnce([
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
      { id: '2', body: 'This loop is O(n^2), consider a map.' },
    ]);

    const count = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(count).toBe(2);
    const playbook = readPlaybook();
    expect(playbook).toContain('PR review feedback — #42');
    expect(playbook).toContain('server/foo.ts');
    expect(playbook).toContain('Please add a null check here.');
    expect(playbook).toContain('This loop is O(n^2), consider a map.');
  });

  it('dedups by comment id on a second call — appends nothing new', async () => {
    const comments = [
      { id: '1', body: 'Please add a null check here.', path: 'server/foo.ts' },
      { id: '2', body: 'This loop is O(n^2), consider a map.' },
    ];
    mockFetch.mockResolvedValueOnce(comments);
    await ingestReviewComments({ repoPath, prNumber: 42 });

    const playbookAfterFirst = readPlaybook();

    mockFetch.mockResolvedValueOnce(comments);
    const secondCount = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(secondCount).toBe(0);
    expect(readPlaybook()).toBe(playbookAfterFirst);
  });

  it('appends only the new comments when some ids were already ingested', async () => {
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
    expect(readPlaybook()).toContain('New comment.');
  });

  it('returns 0 and does not create a playbook when there are no comments', async () => {
    mockFetch.mockResolvedValueOnce([]);

    const count = await ingestReviewComments({ repoPath, prNumber: 42 });

    expect(count).toBe(0);
    expect(fs.existsSync(path.join(repoPath, '.octomux', 'loop-playbook.md'))).toBe(false);
  });
});
