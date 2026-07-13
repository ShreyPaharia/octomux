import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';

const mockStartTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createExtractTaskFromMergedPr } from './pr-extract-service.js';

describe('createExtractTaskFromMergedPr', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pr_extract task with a prompt referencing the PR and the extract CLI', async () => {
    const result = await createExtractTaskFromMergedPr({
      repo_path: '/repo',
      branch: 'main',
      base_branch: 'main',
      pr_number: 99,
      pr_url: 'https://github.com/org/repo/pull/99',
      pr_head_sha: 'sha-xyz',
      title: 'Add feature X',
    });

    expect(result.task.source).toBe('pr_extract');
    expect(result.task.pr_number).toBe(99);
    expect(result.task.initial_prompt).toContain('octomux pr-extract emit');
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: 'task:created',
      payload: { taskId: result.id },
    });
    expect(mockStartTask).toHaveBeenCalled();
  });
});
