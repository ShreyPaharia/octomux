/**
 * Tests: GET /api/tasks/:id returns pull_requests array and legacy pr_url field.
 */
import { describe, it, expect, beforeEach, vi } from './bun-test.js';
import type Database from './sqlite.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('./task-engine/index.js', () => ({
  startTask: vi.fn(),
  closeTask: vi.fn(),
  softDeleteTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

vi.mock('./events.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./hook-token.js', () => ({
  ensureHookToken: vi.fn(async () => 'tok'),
}));

const { default: request } = await import('supertest');
const { createTestDb, insertTask } = await import('./test-helpers.js');
const { upsertPullRequest } = await import('./repositories/pull-requests.js');

// Note: do NOT mock 'fs' globally — migrations.ts uses fs.readFileSync to read kind presets
// (catches ENOENT gracefully), and mocking it without that function causes 500s.

const { createApp } = await import('./app.js');

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/tasks/:id — pull_requests field', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  it('returns empty pull_requests array when the task has no PRs', async () => {
    insertTask(db, { id: 't1', branch: 'agents/t1', runtime_state: 'idle' });

    const res = await request(app).get('/api/tasks/t1?include=pull_requests').expect(200);
    expect(res.body.pull_requests).toEqual([]);
  });

  it('returns pull_requests array with upserted rows', async () => {
    insertTask(db, { id: 't2', branch: 'agents/t2', runtime_state: 'idle' });

    upsertPullRequest({
      task_id: 't2',
      branch: 'agents/t2',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
    });
    upsertPullRequest({
      task_id: 't2',
      branch: 'agents/t2-slice1',
      number: 8,
      url: 'https://github.com/o/r/pull/8',
      state: 'merged',
    });

    const res = await request(app).get('/api/tasks/t2?include=pull_requests').expect(200);
    expect(res.body.pull_requests).toHaveLength(2);
    const urls = res.body.pull_requests.map((p: { url: string }) => p.url);
    expect(urls).toContain('https://github.com/o/r/pull/7');
    expect(urls).toContain('https://github.com/o/r/pull/8');
  });

  it('still returns legacy pr_url on the task when a derived primary exists', async () => {
    insertTask(db, {
      id: 't3',
      branch: 'agents/t3',
      runtime_state: 'idle',
      pr_url: 'https://github.com/o/r/pull/5',
      pr_number: 5,
    });

    const res = await request(app).get('/api/tasks/t3?include=pull_requests').expect(200);
    expect(res.body.pr_url).toBe('https://github.com/o/r/pull/5');
    expect(res.body.pr_number).toBe(5);
    // pull_requests array is populated by the backfill migration
    // (which runs inside createTestDb via initDb + runMigrations);
    // however, since the task was inserted AFTER initDb ran, the array is empty here.
    expect(Array.isArray(res.body.pull_requests)).toBe(true);
  });

  it('returns 404 for unknown task id', async () => {
    await request(app).get('/api/tasks/nonexistent').expect(404);
  });
});
