import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';
import path from 'path';
import type { ComputeFiles, ComputeSession } from '../../compute/types.js';

// writeLoopStatusFile now takes a ComputeSession — a task's worktree may live
// on remote compute, so the write goes through `c.files`, not node `fs`
// directly. A stub ComputeSession decouples this test from fs mocking
// entirely.
function makeFakeCompute(): { compute: ComputeSession; files: ComputeFiles } {
  const files: ComputeFiles = {
    exists: vi.fn(async () => true),
    mkdirp: vi.fn(async () => undefined),
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  };
  const compute = {
    kind: 'fake',
    taskId: 't',
    repoPath: '/wt',
    exec: vi.fn(),
    tmux: vi.fn(),
    spawn: vi.fn(),
    files,
    dispose: vi.fn(async () => undefined),
  } as unknown as ComputeSession;
  return { compute, files };
}

describe('writeLoopStatusFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a JSON status record into .octomux/loop-status.json in the worktree', async () => {
    const { writeLoopStatusFile, STATUS_REL_PATH } = await import('./status-file.js');
    const { compute, files } = makeFakeCompute();

    await writeLoopStatusFile(compute, '/wt', {
      loopRunId: 'run-1',
      groupId: 'group-1',
      taskId: 'task-1',
      status: 'running',
      iteration: 2,
      maxIterations: 10,
      terminationReason: null,
      updatedAt: '2026-07-13T00:00:00.000Z',
    });

    expect(files.mkdirp).toHaveBeenCalledWith(path.join('/wt', '.octomux'));
    const [writtenPath, contents] = vi.mocked(files.write).mock.calls[0];
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
