import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  getTask,
  getAgents,
  findCallback,
  deadSessionMock,
  DEFAULTS,
} from './test-helpers.js';
import type { Task } from './types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout: '[]', stderr: '' });
    return undefined as any;
  }),
}));

vi.mock('./task-runner.js', () => ({
  closeTask: vi.fn(),
}));

vi.mock('./hook-settings.js', () => ({
  installHookSettings: vi.fn(),
}));

const {
  checkTaskStatus,
  pollStatuses,
  ensureHooksInstalled,
  detectPR,
  pollPRs,
  checkMergedPRs,
  startPolling,
  stopPolling,
} = await import('./poller.js');
const { execFile } = await import('child_process');
const { closeTask } = await import('./task-runner.js');
const { installHookSettings } = await import('./hook-settings.js');

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
  // ─── Session death scenarios (table-driven) ────────────────────────────────

  const sessionDeathCases = [
    { taskStatus: 'running' as const, expectedStatus: 'closed', expectedError: undefined },
    { taskStatus: 'setting_up' as const, expectedStatus: 'error', expectedError: 'Setup interrupted' },
  ];

  describe.each(sessionDeathCases)(
    'when $taskStatus task session dies',
    ({ taskStatus, expectedStatus, expectedError }) => {
      beforeEach(() => {
        vi.mocked(execFile).mockImplementation(deadSessionMock as any);
      });

      it(`sets task status to ${expectedStatus}`, async () => {
        insertTask(db, { ...DEFAULTS.runningTask, status: taskStatus });
        insertAgent(db);

        await pollStatuses();

        const task = getTask(db, DEFAULTS.task.id)!;
        expect(task.status).toBe(expectedStatus);
        if (expectedError) expect(task.error).toBe(expectedError);
      });

      it('marks all agents as stopped', async () => {
        insertTask(db, { ...DEFAULTS.runningTask, status: taskStatus });
        insertAgent(db);
        insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

        await pollStatuses();

        const agents = getAgents(db, DEFAULTS.task.id);
        expect(agents.every((a) => a.status === 'stopped')).toBe(true);
      });

      it('sets hook_activity to idle for all agents', async () => {
        insertTask(db, { ...DEFAULTS.runningTask, status: taskStatus });
        insertAgent(db, { hook_activity: 'active' });
        insertAgent(db, {
          id: 'agent-02',
          window_index: 1,
          label: 'Agent 2',
          hook_activity: 'waiting',
        });

        await pollStatuses();

        const agents = getAgents(db, DEFAULTS.task.id);
        expect(agents.every((a) => a.hook_activity === 'idle')).toBe(true);
      });
    },
  );

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

    vi.mocked(execFile).mockImplementation(deadSessionMock as any);

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

// ─── ensureHooksInstalled ───────────────────────────────────────────────────

describe('ensureHooksInstalled', () => {
  it('installs hooks for running tasks with worktrees', () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    ensureHooksInstalled();

    expect(installHookSettings).toHaveBeenCalledWith(DEFAULTS.runningTask.worktree);
  });

  it('installs hooks for multiple running tasks', () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertTask(db, {
      ...DEFAULTS.runningTask,
      id: 'task-02',
      worktree: '/tmp/test-repo/.worktrees/task-02',
    });

    ensureHooksInstalled();

    expect(installHookSettings).toHaveBeenCalledTimes(2);
  });

  const skipCases = [
    { name: 'non-running tasks', overrides: { status: 'closed' as const } },
    { name: 'tasks without worktree', overrides: { worktree: null } },
  ];

  it.each(skipCases)('skips $name', ({ overrides }) => {
    insertTask(db, { ...DEFAULTS.runningTask, ...overrides });

    ensureHooksInstalled();

    expect(installHookSettings).not.toHaveBeenCalled();
  });

  it('does not crash when installHookSettings throws', () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    vi.mocked(installHookSettings).mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => ensureHooksInstalled()).not.toThrow();
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

  const nullReturnCases = [
    { name: 'no PR found', setup: () => {} },
    {
      name: 'gh command fails',
      setup: () => {
        vi.mocked(execFile).mockImplementationOnce((...args: any[]) => {
          const cb = findCallback(...args);
          if (cb) cb(new Error('gh not found'));
          return undefined as any;
        });
      },
    },
    { name: 'branch is null', setup: () => {}, overrides: { branch: null } },
    { name: 'repo_path is empty', setup: () => {}, overrides: { repo_path: '' } },
  ];

  it.each(nullReturnCases)('returns null when $name', async ({ setup, overrides }) => {
    setup?.();
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

  const pollPRSkipCases = [
    { name: 'already has a PR', overrides: { pr_url: 'https://github.com/org/repo/pull/1', pr_number: 1 } },
    { name: 'has no branch', overrides: { branch: null } },
  ];

  it.each(pollPRSkipCases)('skips tasks that $name', async ({ overrides }) => {
    insertTask(db, { ...DEFAULTS.runningTask, ...overrides });

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

// ─── checkMergedPRs ─────────────────────────────────────────────────────────

describe('checkMergedPRs', () => {
  it('closes task when PR is merged', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) {
        const cmdArgs = args[1] as string[];
        if (cmdArgs && cmdArgs[0] === 'pr' && cmdArgs[1] === 'view') {
          cb(null, { stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return undefined as any;
    });

    await checkMergedPRs();

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: DEFAULTS.task.id }));
  });

  it('does not close task when PR is open', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) {
        const cmdArgs = args[1] as string[];
        if (cmdArgs && cmdArgs[0] === 'pr' && cmdArgs[1] === 'view') {
          cb(null, { stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return undefined as any;
    });

    await checkMergedPRs();

    expect(closeTask).not.toHaveBeenCalled();
  });

  it('skips tasks without pr_number', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    await checkMergedPRs();

    expect(execFile).not.toHaveBeenCalled();
    expect(closeTask).not.toHaveBeenCalled();
  });

  it('does not crash when gh command fails', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) cb(new Error('gh not found'));
      return undefined as any;
    });

    await expect(checkMergedPRs()).resolves.not.toThrow();
    expect(closeTask).not.toHaveBeenCalled();
  });

  it('runs gh pr view with correct args in repo directory', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args);
      if (cb) cb(null, { stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' });
      return undefined as any;
    });

    await checkMergedPRs();

    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '42', '--json', 'state'],
      expect.objectContaining({ cwd: DEFAULTS.runningTask.repo_path }),
      expect.any(Function),
    );
  });

  const nonRunningStatuses = ['draft', 'closed', 'error', 'setting_up'] as const;

  it.each(nonRunningStatuses)('skips tasks with status "%s"', async (status) => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      status,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });

    await checkMergedPRs();

    expect(execFile).not.toHaveBeenCalled();
  });
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
