import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { listRunsForWorkflow } from '../../repositories/runs.js';

const mockStartTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createExtractTaskFromMergedPr } from './run.js';

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

  it('records exactly one runs row linking the task with kind pr-extract, trigger github', async () => {
    const result = await createExtractTaskFromMergedPr({
      repo_path: '/repo',
      branch: 'main',
      base_branch: 'main',
      pr_number: 100,
      pr_url: 'https://github.com/org/repo/pull/100',
      pr_head_sha: 'sha-abc',
      title: 'Add feature Y',
    });

    const rows = listRunsForWorkflow('pr-extract');
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('github');
    expect(rows[0].task_id).toBe(result.id);
  });
});
