import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  getTask,
  getAgents,
  DEFAULTS,
} from './test-helpers.js';
import type { Task } from './types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function findCallback(...args: any[]): Function | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i];
  }
  return undefined;
}

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout: '[]', stderr: '' });
    return undefined as any;
  }),
}));

const { checkTaskStatus, pollStatuses, detectPR, pollPRs, startPolling, stopPolling } =
  await import('./poller.js');
const { execFile } = await import('child_process');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  // Re-set default mock (clearAllMocks removes implementations)
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout: '[]', stderr: '' });
    return undefined as any;
  });
});

afterEach(() => {
  db.close();
  stopPolling();
});

// ─── checkTaskStatus ─────────────────────────────────────────────────────────

describe('checkTaskStatus', () => {
  it('returns "alive" when tmux has-session succeeds', async () => {
    const result = await checkTaskStatus({ ...DEFAULTS.runningTask } as Task);
    expect(result).toBe('alive');
  });

  it('returns "dead" when tmux has-session fails', async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });
    const result = await checkTaskStatus({ ...DEFAULTS.runningTask } as Task);
    expect(result).toBe('dead');
  });

  it('returns "dead" when tmux_session is null', async () => {
    const result = await checkTaskStatus({ ...DEFAULTS.task, tmux_session: null } as Task);
    expect(result).toBe('dead');
  });

  it('calls tmux has-session with correct session name', async () => {
    await checkTaskStatus({ ...DEFAULTS.runningTask } as Task);
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['has-session', '-t', DEFAULTS.runningTask.tmux_session],
      expect.any(Function),
    );
  });
});

// ─── pollStatuses ────────────────────────────────────────────────────────────

describe('pollStatuses', () => {
  it('marks running task as closed when session dies', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    // Make has-session fail (session dead)
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.status).toBe('closed');
  });

  it('marks running agents as stopped when session dies', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      if (typeof callback === 'function') callback(new Error('dead'));
      return undefined as any;
    });

    await pollStatuses();

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  it('does not modify task when session is alive', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.status).toBe('running');
  });

  // ─── Status filtering (table-driven) ──────────────────────────────────────

  const ignoredStatuses = ['draft', 'closed', 'error'] as const;

  it.each(ignoredStatuses)('ignores tasks with status "%s"', async (status) => {
    insertTask(db, { ...DEFAULTS.runningTask, status });

    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      if (typeof callback === 'function') callback(new Error('dead'));
      return undefined as any;
    });

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.status).toBe(status);
  });

  it('handles multiple running tasks', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertTask(db, {
      ...DEFAULTS.runningTask,
      id: 'task-02',
      tmux_session: 'octomux-agent-task-02',
      branch: 'agents/task-02',
      worktree: '/tmp/test-repo/.worktrees/task-02',
    });

    await pollStatuses();

    // Both should still be running (mock returns success)
    expect(getTask(db, DEFAULTS.task.id)!.status).toBe('running');
    expect(getTask(db, 'task-02')!.status).toBe('running');
  });
});

// ─── detectPR ────────────────────────────────────────────────────────────────

describe('detectPR', () => {
  it('returns PR data when gh pr list finds a PR', async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) {
        cb(null, {
          stdout: JSON.stringify([{ url: 'https://github.com/org/repo/pull/42', number: 42 }]),
          stderr: '',
        });
      }
      return undefined as any;
    });

    const result = await detectPR({ ...DEFAULTS.runningTask } as Task);
    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/42', number: 42 });
  });

  it('returns null when no PR found', async () => {
    const result = await detectPR({ ...DEFAULTS.runningTask } as Task);
    expect(result).toBeNull();
  });

  it('returns null when gh command fails', async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) cb(new Error('gh not found'));
      return undefined as any;
    });

    const result = await detectPR({ ...DEFAULTS.runningTask } as Task);
    expect(result).toBeNull();
  });

  const nullFieldCases = [
    { name: 'branch is null', overrides: { branch: null } },
    { name: 'repo_path is null', overrides: { repo_path: '' } },
  ];

  it.each(nullFieldCases)('returns null when $name', async ({ overrides }) => {
    const result = await detectPR({ ...DEFAULTS.runningTask, ...overrides } as Task);
    expect(result).toBeNull();
  });

  it('runs gh in the repo directory', async () => {
    await detectPR({ ...DEFAULTS.runningTask } as Task);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'list', '--head', DEFAULTS.runningTask.branch, '--json', 'url,number', '--limit', '1'],
      expect.objectContaining({ cwd: DEFAULTS.runningTask.repo_path }),
      expect.any(Function),
    );
  });
});

// ─── pollPRs ─────────────────────────────────────────────────────────────────

describe('pollPRs', () => {
  it('updates task when PR is detected', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    vi.mocked(execFile).mockImplementation((...mockArgs: any[]) => {
      const cb = findCallback(...mockArgs);
      if (cb) {
        const args = mockArgs[1] as string[];
        if (args && args[0] === 'pr') {
          cb(null, {
            stdout: JSON.stringify([{ url: 'https://github.com/org/repo/pull/99', number: 99 }]),
            stderr: '',
          });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return undefined as any;
    });

    await pollPRs();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.pr_url).toBe('https://github.com/org/repo/pull/99');
    expect(task.pr_number).toBe(99);
  });

  it('skips tasks that already have a PR', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_url: 'https://github.com/org/repo/pull/1',
      pr_number: 1,
    });

    await pollPRs();

    // execFile should not be called for gh (task already has PR)
    expect(execFile).not.toHaveBeenCalled();
  });

  it('skips tasks without a branch', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, branch: null });

    await pollPRs();

    expect(execFile).not.toHaveBeenCalled();
  });

  // ─── Status filtering for PR poll (table-driven) ──────────────────────────

  const prPollStatuses = [
    { status: 'running', shouldPoll: true },
    { status: 'closed', shouldPoll: true },
    { status: 'draft', shouldPoll: false },
    { status: 'setting_up', shouldPoll: false },
    { status: 'error', shouldPoll: false },
  ] as const;

  it.each(prPollStatuses)(
    'status "$status" → shouldPoll=$shouldPoll',
    async ({ status, shouldPoll }) => {
      insertTask(db, { ...DEFAULTS.runningTask, status });

      await pollPRs();

      if (shouldPoll) {
        expect(execFile).toHaveBeenCalled();
      } else {
        expect(execFile).not.toHaveBeenCalled();
      }
    },
  );
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe('startPolling / stopPolling', () => {
  it('startPolling does not throw', () => {
    expect(() => startPolling()).not.toThrow();
  });

  it('stopPolling does not throw when not started', () => {
    expect(() => stopPolling()).not.toThrow();
  });

  it('stopPolling cleans up after startPolling', () => {
    startPolling();
    expect(() => stopPolling()).not.toThrow();
  });
});
