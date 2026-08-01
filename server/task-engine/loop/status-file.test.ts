import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('fs');

describe('writeLoopStatusFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as unknown as string);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it('writes a JSON status record into .octomux/loop-status.json in the worktree', async () => {
    const { writeLoopStatusFile, STATUS_REL_PATH } = await import('./status-file.js');
    writeLoopStatusFile('/wt', {
      loopRunId: 'run-1',
      groupId: 'group-1',
      taskId: 'task-1',
      status: 'running',
      iteration: 2,
      maxIterations: 10,
      terminationReason: null,
      updatedAt: '2026-07-13T00:00:00.000Z',
    });

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join('/wt', '.octomux'), { recursive: true });
    const [writtenPath, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writtenPath).toBe(path.join('/wt', STATUS_REL_PATH));
    expect(JSON.parse(contents as string)).toEqual({
      loopRunId: 'run-1',
      groupId: 'group-1',
      taskId: 'task-1',
      status: 'running',
      iteration: 2,
      maxIterations: 10,
      terminationReason: null,
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
  });
});
