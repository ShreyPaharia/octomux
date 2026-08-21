import { describe, it, expect, beforeEach, vi } from '../bun-test.js';
import Database from '../sqlite.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// recoverTasks() only needs to route each stale task to the right resume
// path — the internals of resumeTask (--resume/--continue ladder) and
// resumeLoopOnStartup (fresh respawn) are covered by their own test files.

vi.mock('fs', (importOriginal) => {
  const actual = importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    // recoverTasks() now checks worktree existence via ComputeFiles
    // (fs.promises.access under the hood for local compute), not
    // fs.existsSync directly — mock both so the fixture's fake path still
    // reads as "exists".
    promises: { ...actual.promises, access: vi.fn(async () => undefined) },
  };
  return { ...mocked, default: mocked };
});

vi.mock('../poller/status.js', () => ({
  checkTaskStatus: vi.fn(async () => 'dead'),
}));

vi.mock('./lifecycle.js', () => ({
  resumeTask: vi.fn(async () => undefined),
}));

vi.mock('./loop/engine.js', () => ({
  resumeLoopOnStartup: vi.fn(async () => undefined),
}));

const { createTestDb, insertTask, DEFAULTS } = await import('../test-helpers.js');

const { recoverTasks } = await import('./reconcile.js');
const { checkTaskStatus } = await import('../poller/status.js');
const { resumeTask } = await import('./lifecycle.js');
const { resumeLoopOnStartup } = await import('./loop/engine.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(checkTaskStatus).mockResolvedValue('dead');
});

describe('recoverTasks', () => {
  it('resumes a looping task via the fresh-context loop path, never --resume', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, id: 't-loop', runtime_state: 'looping' });

    await recoverTasks();

    expect(resumeLoopOnStartup).toHaveBeenCalledTimes(1);
    expect(resumeLoopOnStartup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-loop', runtime_state: 'looping' }),
    );
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('resumes a normal running task via the existing --resume path (regression)', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, id: 't-normal', runtime_state: 'running' });

    await recoverTasks();

    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect(resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-normal', runtime_state: 'running' }),
    );
    expect(resumeLoopOnStartup).not.toHaveBeenCalled();
  });

  it('skips a looping task whose tmux session is still alive', async () => {
    vi.mocked(checkTaskStatus).mockResolvedValue('alive');
    insertTask(db, { ...DEFAULTS.runningTask, id: 't-alive', runtime_state: 'looping' });

    await recoverTasks();

    expect(resumeLoopOnStartup).not.toHaveBeenCalled();
    expect(resumeTask).not.toHaveBeenCalled();
  });
});
