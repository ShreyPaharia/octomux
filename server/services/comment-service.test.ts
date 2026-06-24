/**
 * Unit tests for the inline-comment service (SHR-176).
 *
 * Covers the domain guards (anchor / binary-diff / line-range) that throw
 * ServiceError with the right status, plus the happy path that inserts a row.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTestTask } from '../test-helpers.js';

// ─── Mock git execFile + the diff module ────────────────────────────────────

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const mockGetFileDiff = vi.fn();
vi.mock('@octomux/diff-engine', () => ({
  getFileDiff: (...args: unknown[]) => mockGetFileDiff(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createInlineComment, type CreateInlineCommentInput } from './comment-service.js';

/** Drive the promisified execFile callback with success. */
function execOk(stdout: string) {
  return (...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: unknown, r: { stdout: string; stderr: string }) => void;
    cb(null, { stdout, stderr: '' });
  };
}

/** Drive the promisified execFile callback with an error. */
function execFail(message: string) {
  return (...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: unknown) => void;
    cb(new Error(message));
  };
}

function baseInput(overrides: Partial<CreateInlineCommentInput> = {}): CreateInlineCommentInput {
  return {
    cwd: '/tmp/test-repo/.worktrees/wt',
    task_id: 'test-task-01',
    base_sha: 'base-sha-0000',
    file_path: 'src/foo.ts',
    line: 3,
    side: 'new',
    body: 'looks off',
    agent_id: null,
    anchor_commit_sha: 'anchor-sha-1234',
    ...overrides,
  };
}

function okDiff(overrides: Record<string, unknown> = {}) {
  return {
    oldContent: 'a\nb\nc\n',
    newContent: 'a\nb\nc\n',
    status: 'M',
    tooLarge: false,
    binary: false,
    isDirectory: false,
    ...overrides,
  };
}

describe('comment-service.createInlineComment', () => {
  beforeEach(() => {
    createTestDb();
    insertTestTask({ id: 'test-task-01' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a comment on the happy path', async () => {
    mockGetFileDiff.mockResolvedValue(okDiff());
    // `git show <anchor>:<file>` returns the anchored file content (3 lines).
    mockExecFile.mockImplementation(execOk('a\nb\nc\n'));

    const row = await createInlineComment(baseInput());

    expect(row.file_path).toBe('src/foo.ts');
    expect(row.line).toBe(3);
    expect(row.original_commit_sha).toBe('anchor-sha-1234');
    expect(row.body).toBe('looks off');
  });

  it('resolves HEAD via git when no anchor sha is supplied', async () => {
    mockGetFileDiff.mockResolvedValue(okDiff());
    // First call: git rev-parse HEAD → anchor; second: git show → content.
    mockExecFile
      .mockImplementationOnce(execOk('head-sha-9999\n'))
      .mockImplementationOnce(execOk('a\nb\nc\n'));

    const row = await createInlineComment(baseInput({ anchor_commit_sha: undefined }));
    expect(row.original_commit_sha).toBe('head-sha-9999');
  });

  it('throws ServiceError(500) when resolving HEAD fails', async () => {
    mockExecFile.mockImplementation(execFail('not a git repo'));
    await expect(
      createInlineComment(baseInput({ anchor_commit_sha: undefined })),
    ).rejects.toMatchObject({ name: 'ServiceError', status: 500 });
  });

  it('throws ServiceError(400) on a binary file', async () => {
    mockGetFileDiff.mockResolvedValue(okDiff({ binary: true }));
    await expect(createInlineComment(baseInput())).rejects.toMatchObject({
      name: 'ServiceError',
      status: 400,
    });
  });

  it('throws ServiceError(400) when the file is missing at the anchor commit', async () => {
    mockGetFileDiff.mockResolvedValue(okDiff());
    // git show <anchor>:<file> fails → file not found at anchor.
    mockExecFile.mockImplementation(execFail('fatal: path does not exist'));
    await expect(createInlineComment(baseInput())).rejects.toMatchObject({
      name: 'ServiceError',
      status: 400,
    });
  });

  it('throws ServiceError(400) when the line is out of range at the anchor', async () => {
    mockGetFileDiff.mockResolvedValue(okDiff());
    // Anchored content has only 3 lines; comment targets line 99.
    mockExecFile.mockImplementation(execOk('a\nb\nc\n'));
    await expect(createInlineComment(baseInput({ line: 99 }))).rejects.toMatchObject({
      name: 'ServiceError',
      status: 400,
    });
  });

  it('surfaces getFileDiff failures as ServiceError(500)', async () => {
    mockGetFileDiff.mockRejectedValue(new Error('diff blew up'));
    await expect(createInlineComment(baseInput())).rejects.toMatchObject({
      name: 'ServiceError',
      status: 500,
    });
  });
});
