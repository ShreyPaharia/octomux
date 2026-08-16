// Tests for three performance optimisations on hot read paths:
//   1. Diff summary caching — second GET with unchanged base_sha must not re-invoke getDiffSummary
//   2. computeOutdated git deduplication — only one git show per (sha, path) pair
//   3. Hook-token backfill off the hot read path — zero token generation when tokens already exist

import Database from './sqlite.js';
import { describe, it, expect, beforeEach, afterEach, vi } from './bun-test.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn(),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  softDeleteTask: vi.fn(),
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
    files: (summary.files ?? []).map((f: Record<string, unknown>) => ({
      ...f,
      reviewed: false,
      reviewed_at: null,
      reviewed_at_commit: null,
      changed_since_review: false,
    })),
  })),
}));

vi.mock('@octomux/diff-engine', () => {
  const actual =
    vi.importActual<typeof import('@octomux/diff-engine')>('@octomux/diff-engine');
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
  };
});

vi.mock('./hook-token.js', () => ({
  ensureHookToken: vi.fn(async (_agent: any, _path: any) => 'minted-token'),
}));

vi.mock('./chats.js', () => ({
  createChat: vi.fn(),
  listChats: vi.fn(() => []),
  getChat: vi.fn(() => null),
  closeChat: vi.fn(),
  deleteChat: vi.fn(),
}));

vi.mock('./skills.js', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
  })),
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    ...patch,
  })),
}));

const { default: request } = await import('supertest');
const { createTestDb, insertTask, insertAgent, DEFAULTS } = await import('./test-helpers.js');

const diffModule = await import('@octomux/diff-engine');
const { ensureHookToken } = await import('./hook-token.js');
const { clearDiffSummaryCache } = await import('./routes/diffs.js');

const { createApp } = await import('./app.js');

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let db: Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.restoreAllMocks();
  clearDiffSummaryCache();
  db = createTestDb();
  app = createApp();
});

afterEach(() => {
  db.close();
});

// ─── Task 1: Diff summary caching ─────────────────────────────────────────────

describe('GET /api/tasks/:id/diff — summary caching', () => {
  const MOCK_SUMMARY = {
    files: [{ path: 'a.ts', status: 'M', additions: 2, deletions: 1 }],
    base_sha: DEFAULTS.runningTask.base_sha,
    base_ref: 'origin/main',
    base_is_stale: false,
    total_count: 1,
  };

  beforeEach(() => {
    (diffModule.getDiffSummary as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SUMMARY);
  });

  it('returns 200 on first call', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    expect(res.status).toBe(200);
    expect(diffModule.getDiffSummary).toHaveBeenCalledTimes(1);
  });

  it('does NOT call getDiffSummary a second time when base_sha is unchanged', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const id = DEFAULTS.runningTask.id;

    const res1 = await request(app).get(`/api/tasks/${id}/diff`);
    expect(res1.status).toBe(200);

    const res2 = await request(app).get(`/api/tasks/${id}/diff`);
    expect(res2.status).toBe(200);

    // getDiffSummary should only have been called once — second hit is from cache.
    expect(diffModule.getDiffSummary).toHaveBeenCalledTimes(1);
  });

  it('calls getDiffSummary again when base_sha changes', async () => {
    const id = DEFAULTS.runningTask.id;
    insertTask(db, { ...DEFAULTS.runningTask, base_sha: 'sha-before-111111111111111111111111111' });

    await request(app).get(`/api/tasks/${id}/diff`);
    expect(diffModule.getDiffSummary).toHaveBeenCalledTimes(1);

    // Simulate a base change by updating the worktree row.
    db.prepare(
      `UPDATE worktrees SET base_sha = ? WHERE id = (SELECT worktree_id FROM tasks WHERE id = ?)`,
    ).run('sha-after-222222222222222222222222222', id);

    const getMock = diffModule.getDiffSummary as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValue({
      ...MOCK_SUMMARY,
      base_sha: 'sha-after-222222222222222222222222222',
    });

    await request(app).get(`/api/tasks/${id}/diff`);
    // Second call because the key changed.
    expect(diffModule.getDiffSummary).toHaveBeenCalledTimes(2);
  });

  it('does NOT hard-fail when caching itself would fail (fetch function error propagates)', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    (diffModule.getDiffSummary as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('git unavailable'),
    );
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}/diff`);
    // The underlying error should surface as a 500, not a cache crash.
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ─── Task 3: Hook-token backfill off the read path ───────────────────────────

describe('GET /api/tasks/:id — hook token backfill', () => {
  it('issues zero ensureHookToken calls when all agents already have tokens', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    // Insert two agents, both with non-empty hook tokens.
    insertAgent(db, { id: 'w1', task_id: DEFAULTS.runningTask.id, hook_token: 'tok-aaa' });
    insertAgent(db, { id: 'w2', task_id: DEFAULTS.runningTask.id, hook_token: 'tok-bbb' });

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}?include=workers`);
    expect(res.status).toBe(200);

    // ensureHookToken must not have been called at all.
    expect(ensureHookToken).not.toHaveBeenCalled();
  });

  it('calls ensureHookToken only for agents missing a token', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, { id: 'w3', task_id: DEFAULTS.runningTask.id, hook_token: 'tok-existing' });
    insertAgent(db, { id: 'w4', task_id: DEFAULTS.runningTask.id, hook_token: '' });

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}?include=workers`);
    expect(res.status).toBe(200);

    // Only the agent with an empty token should trigger ensureHookToken.
    expect(ensureHookToken).toHaveBeenCalledTimes(1);
    expect(ensureHookToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w4' }),
      expect.anything(),
    );
  });

  it('returns task successfully even with no agents', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}?include=workers`);
    expect(res.status).toBe(200);
    expect(ensureHookToken).not.toHaveBeenCalled();
  });
});
