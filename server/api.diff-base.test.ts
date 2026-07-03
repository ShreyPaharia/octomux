// Focused tests for the fix: the per-file diff endpoint must use the resolved
// live base SHA (from resolveDiffBase), not task.base_sha — and both endpoints
// must surface BaseUnavailableError as a 503 with the `base_unavailable` code.
//
// Lives in a dedicated file rather than api.test.ts because we mock
// `./@octomux/diff-engine`, which the shared test would have to thread through every
// existing test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, DEFAULTS } from './test-helpers.js';

vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn(),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readdirSync: vi.fn(() => []),
    existsSync: vi.fn(() => true),
    promises: {
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => []),
      access: vi.fn(async () => {}),
    },
  },
}));

vi.mock('./diff-review-state.js', () => ({
  decorateDiffSummaryWithReviewState: vi.fn(async (_taskId, _wt, summary) => ({
    ...summary,
    reviewed_count: 0,
    files: summary.files.map((f: (typeof summary.files)[number]) => ({
      ...f,
      reviewed: false,
      reviewed_at: null,
      reviewed_at_commit: null,
      changed_since_review: false,
    })),
  })),
}));

vi.mock('@octomux/diff-engine', async () => {
  const actual =
    await vi.importActual<typeof import('@octomux/diff-engine')>('@octomux/diff-engine');
  return {
    ...actual,
    getDiffSummary: vi.fn(),
    getFileDiff: vi.fn(),
    resolveDiffBase: vi.fn(),
    resolveRef: vi.fn(async () => 'resolved-sha'),
    clearDiffBaseCache: vi.fn(),
    safeResolvePath: (wt: string, p: string) => {
      if (!p || p.includes('..') || p.startsWith('/')) throw new Error('Invalid path');
      return `${wt}/${p}`;
    },
    MAX_FILE_BYTES: 1_048_576,
  };
});

const diffMod = await import('@octomux/diff-engine');
const diffBaseMod = diffMod;
const { createApp } = await import('./app.js');

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.restoreAllMocks();
  db = createTestDb();
  app = createApp();
});

afterEach(() => {
  db.close();
});

describe('per-file diff endpoint uses resolved live base', () => {
  it('passes resolveDiffBase().sha (not task.base_sha) to getFileDiff', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      base_branch: 'main',
      base_sha: 'snapshot1234567890snapshot1234567890snap',
    });
    (diffBaseMod.resolveDiffBase as any).mockResolvedValue({
      sha: 'live----0000000000000000000000000000live',
      ref: 'origin/main',
      is_stale: false,
    });
    (diffMod.getFileDiff as any).mockResolvedValue({
      oldContent: 'old\n',
      newContent: 'new\n',
      status: 'M',
      tooLarge: false,
      binary: false,
    });

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff/a.txt`);

    expect(res.status).toBe(200);
    expect(diffMod.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        taskBaseSha: 'live----0000000000000000000000000000live',
        relPath: 'a.txt',
      }),
    );
    // Confirm the snapshot was NOT used as the base.
    const call = (diffMod.getFileDiff as any).mock.calls[0][0];
    expect(call.taskBaseSha).not.toBe('snapshot1234567890snapshot1234567890snap');
  });

  it('returns 503 base_unavailable when resolveDiffBase throws', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      base_branch: 'main',
      base_sha: 'snapshot1234567890snapshot1234567890snap',
    });
    (diffBaseMod.resolveDiffBase as any).mockRejectedValue(
      new diffBaseMod.BaseUnavailableError('could not resolve origin/main: offline'),
    );

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff/a.txt`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('base_unavailable');
  });
});

describe('summary diff endpoint surfaces BaseUnavailableError', () => {
  it('returns 503 base_unavailable when getDiffSummary throws', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      base_branch: 'main',
      base_sha: 'snapshot1234567890snapshot1234567890snap',
    });
    (diffMod.getDiffSummary as any).mockRejectedValue(
      new diffBaseMod.BaseUnavailableError('could not resolve origin/main: offline'),
    );

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('base_unavailable');
  });

  it('returns 422 base_branch_missing when the base branch is gone on origin and locally', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      base_branch: 'featureX',
      base_sha: 'snapshot1234567890snapshot1234567890snap',
    });
    (diffMod.getDiffSummary as any).mockRejectedValue(
      new diffBaseMod.BaseBranchMissingError(
        "base branch 'featureX' not found on origin or locally",
      ),
    );

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('base_branch_missing');
  });
});
