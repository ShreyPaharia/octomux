import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, insertTestTask } from '../test-helpers.js';

const mockIngest = vi.fn().mockResolvedValue(0);
vi.mock('../services/comment-feedback.js', () => ({
  ingestReviewComments: (...args: unknown[]) => mockIngest(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { checkTriagePrComments, pollTriagePrComments } from './triage-pr-comments.js';

describe('checkTriagePrComments', () => {
  beforeEach(() => {
    createTestDb();
    mockIngest.mockClear();
    mockIngest.mockResolvedValue(0);
  });

  it('ingests review comments once for a running prod_log_triage task with an open PR', async () => {
    insertTestTask({
      id: 'triage-1',
      source: 'prod_log_triage',
      runtime_state: 'running',
      repo_path: '/repo/triage',
      pr_number: 42,
    });

    await checkTriagePrComments();

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo/triage',
        prNumber: 42,
        task: expect.objectContaining({ id: 'triage-1' }),
      }),
    );
  });

  it('does not call ingest for tasks with no PR yet, or non-triage sources', async () => {
    insertTestTask({
      id: 'triage-no-pr',
      source: 'prod_log_triage',
      runtime_state: 'running',
      repo_path: '/repo/triage',
      pr_number: null,
    });
    insertTestTask({
      id: 'pr-extract-1',
      source: 'pr_extract',
      runtime_state: 'running',
      repo_path: '/repo/other',
      pr_number: 7,
    });

    await checkTriagePrComments();

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('continues processing other tasks when one ingest call throws', async () => {
    insertTestTask({
      id: 'triage-fails',
      source: 'prod_log_triage',
      runtime_state: 'running',
      repo_path: '/repo/fails',
      pr_number: 1,
    });
    insertTestTask({
      id: 'triage-ok',
      source: 'prod_log_triage',
      runtime_state: 'running',
      repo_path: '/repo/ok',
      pr_number: 2,
    });
    mockIngest.mockRejectedValueOnce(new Error('gh failed'));

    await expect(checkTriagePrComments()).resolves.toBeUndefined();

    expect(mockIngest).toHaveBeenCalledTimes(2);
  });

  it('pollTriagePrComments never throws, even if the check fails', async () => {
    insertTestTask({
      id: 'triage-1',
      source: 'prod_log_triage',
      runtime_state: 'running',
      repo_path: '/repo/triage',
      pr_number: 42,
    });
    mockIngest.mockRejectedValueOnce(new Error('boom'));

    await expect(pollTriagePrComments()).resolves.toBeUndefined();
  });
});
