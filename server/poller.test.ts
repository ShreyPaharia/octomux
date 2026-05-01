import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertUserTerminal,
  getTask,
  getAgents,
  getUserTerminals,
  findCallback,
  deadSessionMock,
  execFileOk,
  execFileFail,
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
// Note: the vi.mock factory above runs during import hoisting, so it can't use
// imported helpers. Everything below (after imports resolve) can use execFileOk.

vi.mock('./task-runner.js', () => ({
  closeTask: vi.fn(),
}));

vi.mock('./hook-settings.js', () => ({
  installHookSettings: vi.fn(),
}));

vi.mock('./events.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./github-login.js', () => ({
  readGithubLogin: vi.fn(() => 'owner-login'),
}));

const {
  checkTaskStatus,
  pollStatuses,
  pollTerminalActivity,
  ensureHooksInstalled,
  detectPR,
  pollPRs,
  checkMergedPRs,
  pollReviewerRequests,
  startPolling,
  stopPolling,
} = await import('./poller.js');
const { execFile } = await import('child_process');
const { closeTask } = await import('./task-runner.js');
const { installHookSettings } = await import('./hook-settings.js');
const { broadcast } = await import('./events.js');
const { readGithubLogin } = await import('./github-login.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  // Re-set default mock (clearAllMocks removes implementations)
  vi.mocked(execFile).mockImplementation(execFileOk('[]') as any);
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
    vi.mocked(execFile).mockImplementationOnce(deadSessionMock as any);
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
    {
      taskStatus: 'setting_up' as const,
      expectedStatus: 'error',
      expectedError: 'Setup interrupted',
    },
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

  it('does not mark "setting_up" as Setup interrupted when tmux_session is null', async () => {
    // Reproduces the race where startTask has written status='setting_up' but
    // hasn't yet created the tmux session. Poller must leave the task alone.
    insertTask(db, { ...DEFAULTS.runningTask, status: 'setting_up', tmux_session: null });
    vi.mocked(execFile).mockImplementation(deadSessionMock as any);

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.status).toBe('setting_up');
    expect(task.error).toBeNull();
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
    vi.mocked(execFile).mockImplementationOnce(
      execFileOk(
        JSON.stringify([{ url: 'https://github.com/org/repo/pull/42', number: 42 }]),
      ) as any,
    );

    const result = await detectPR({ ...DEFAULTS.runningTask } as Task);
    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/42', number: 42 });
  });

  const nullReturnCases = [
    { name: 'no PR found', setup: () => {} },
    {
      name: 'gh command fails',
      setup: () => {
        vi.mocked(execFile).mockImplementationOnce(execFileFail('gh not found') as any);
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
    {
      name: 'already has a PR',
      overrides: { pr_url: 'https://github.com/org/repo/pull/1', pr_number: 1 },
    },
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

// ─── pollTerminalActivity ────────────────────────────────────────────────────

describe('pollTerminalActivity', () => {
  it('updates terminal status to working when process is not shell', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id, status: 'idle' });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args)!;
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'npm', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals[0].status).toBe('working');
  });

  it('updates terminal status to idle when process is shell', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id, status: 'working' });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args)!;
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'zsh', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals[0].status).toBe('idle');
  });

  it('broadcasts update when status changes', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id, status: 'idle' });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args)!;
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'npm', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: DEFAULTS.runningTask.id },
    });
  });

  it('does not broadcast when status unchanged', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id, status: 'idle' });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args)!;
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'zsh', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

// ─── pollReviewerRequests ───────────────────────────────────────────────────

describe('pollReviewerRequests', () => {
  const REPO = '/tmp/test-repo';
  const OWNER = 'owner-login';

  const makePR = (overrides: Record<string, unknown> = {}) => ({
    number: 42,
    title: 'Add thing',
    url: 'https://github.com/org/repo/pull/42',
    author: { login: 'teammate' },
    headRefOid: 'sha-aaa',
    headRefName: 'feat/thing',
    baseRefName: 'main',
    reviewRequests: [{ login: OWNER }],
    ...overrides,
  });

  /** Install an execFile mock that returns the given PR list for gh pr list calls. */
  function mockPrList(prs: Array<Record<string, unknown>>) {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args)!;
      const cmdArgs = args[1] as string[];
      if (cmdArgs?.[0] === 'pr' && cmdArgs?.[1] === 'list') {
        cb(null, { stdout: JSON.stringify(prs), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });
  }

  beforeEach(() => {
    vi.mocked(readGithubLogin).mockReturnValue(OWNER);
  });

  it('skips polling when owner login is not resolved', async () => {
    vi.mocked(readGithubLogin).mockReturnValue(null);
    // Seed a tracked repo via a task row
    insertTask(db, { id: 'seed', repo_path: REPO });

    await pollReviewerRequests();

    // Should not have shelled out
    const prListCall = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'pr' && args?.[1] === 'list';
    });
    expect(prListCall).toBeUndefined();
  });

  it('creates a draft auto-review task when owner is a reviewer', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([makePR()]);

    await pollReviewerRequests();

    const created = db
      .prepare(
        `SELECT t.id, t.status, t.title, t.pr_number, t.pr_head_sha, t.initial_prompt,
                w.branch AS branch, w.base_branch AS base_branch
           FROM tasks t LEFT JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.source = 'auto_review'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(created).toBeDefined();
    expect(created!.status).toBe('draft');
    expect(created!.pr_number).toBe(42);
    expect(created!.pr_head_sha).toBe('sha-aaa');
    expect(created!.base_branch).toBe('main');
    expect((created!.branch as string).startsWith('review/')).toBe(true);
    expect(created!.branch).toContain('pr-42');
    expect(created!.title).toContain('#42');
    expect((created!.initial_prompt as string).startsWith('/review-pr https://github.com')).toBe(
      true,
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:created',
      payload: { taskId: created!.id },
    });
  });

  it('skips when owner is not in reviewRequests (e.g. already reviewed)', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([makePR({ reviewRequests: [{ login: 'someone-else' }] })]);

    await pollReviewerRequests();

    const created = db.prepare(`SELECT * FROM tasks WHERE source = 'auto_review'`).get();
    expect(created).toBeUndefined();
  });

  it('dedupes: does not create a second task when one already exists for same PR', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'existing-review',
      repo_path: REPO,
      status: 'draft',
      pr_number: 42,
      pr_head_sha: 'sha-aaa',
      source: 'auto_review',
    });
    mockPrList([makePR()]);

    await pollReviewerRequests();

    const autoReviews = db
      .prepare(`SELECT id FROM tasks WHERE source = 'auto_review' AND pr_number = 42`)
      .all();
    expect(autoReviews).toHaveLength(1);
  });

  it('updates the draft prompt when head SHA advances', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'existing-review',
      repo_path: REPO,
      status: 'draft',
      pr_number: 42,
      pr_head_sha: 'sha-old',
      initial_prompt: '/review-pr https://github.com/org/repo/pull/42\n\nold body',
      source: 'auto_review',
    });
    mockPrList([makePR({ headRefOid: 'sha-new' })]);

    await pollReviewerRequests();

    const updated = getTask(db, 'existing-review')!;
    expect(updated.pr_head_sha).toBe('sha-new');
    expect(updated.initial_prompt).toContain('head advanced to sha-new');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: 'existing-review' },
    });
  });

  it('does not modify owner-created tasks even on a matching dedupe key', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'manual',
      repo_path: REPO,
      status: 'draft',
      pr_number: 42,
      pr_head_sha: 'sha-old',
      initial_prompt: 'manual-prompt',
      source: null, // owner-created
    });
    mockPrList([makePR({ headRefOid: 'sha-new' })]);

    await pollReviewerRequests();

    const manual = getTask(db, 'manual')!;
    expect(manual.initial_prompt).toBe('manual-prompt');
    expect(manual.pr_head_sha).toBe('sha-old');
    // And no new auto-review row was created for that PR either
    const autos = db
      .prepare(`SELECT id FROM tasks WHERE source = 'auto_review' AND pr_number = 42`)
      .all();
    expect(autos).toHaveLength(0);
  });

  it('nudges the running agent via tmux send-keys when PR head advances mid-review', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      status: 'running',
      tmux_session: 'octomux-agent-running-review',
      pr_number: 42,
      pr_head_sha: 'sha-old',
      source: 'auto_review',
    });
    insertAgent(db, {
      id: 'agent-a',
      task_id: 'running-review',
      window_index: 0,
      status: 'running',
    });
    mockPrList([makePR({ headRefOid: 'sha-new' })]);

    await pollReviewerRequests();

    const sendKeys = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'send-keys';
    });
    expect(sendKeys).toBeDefined();
    const args = sendKeys![1] as string[];
    expect(args).toContain('-t');
    expect(args).toContain('octomux-agent-running-review:0');
    const message = args.find((a) => a.includes('Re-review requested'));
    expect(message).toBeDefined();
    expect(message).toContain('sha-new');
    expect(message).toContain('#42');

    // SHA recorded so we don't re-nudge on the next tick
    const task = getTask(db, 'running-review')!;
    expect(task.pr_head_sha).toBe('sha-new');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: 'running-review' },
    });
  });

  it('does not re-nudge a running review when head SHA is unchanged', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      status: 'running',
      tmux_session: 'octomux-agent-running-review',
      pr_number: 42,
      pr_head_sha: 'sha-aaa',
      source: 'auto_review',
    });
    insertAgent(db, {
      id: 'agent-a',
      task_id: 'running-review',
      window_index: 0,
      status: 'running',
    });
    mockPrList([makePR({ headRefOid: 'sha-aaa' })]);

    await pollReviewerRequests();

    const sendKeys = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'send-keys';
    });
    expect(sendKeys).toBeUndefined();
  });

  it('does not nudge owner-created running tasks', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'manual-running',
      repo_path: REPO,
      status: 'running',
      tmux_session: 'octomux-agent-manual-running',
      pr_number: 42,
      pr_head_sha: 'sha-old',
      source: null,
    });
    insertAgent(db, {
      id: 'agent-m',
      task_id: 'manual-running',
      window_index: 0,
      status: 'running',
    });
    mockPrList([makePR({ headRefOid: 'sha-new' })]);

    await pollReviewerRequests();

    const sendKeys = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'send-keys';
    });
    expect(sendKeys).toBeUndefined();
    // SHA untouched
    expect(getTask(db, 'manual-running')!.pr_head_sha).toBe('sha-old');
  });

  it('deletes draft auto-review tasks when the reviewer request is resolved', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    const stale = insertTask(db, {
      id: 'stale-review',
      repo_path: REPO,
      status: 'draft',
      pr_number: 99,
      pr_head_sha: 'sha-old',
      source: 'auto_review',
    });
    // gh returns no PRs — i.e. owner no longer requested / PR merged / closed
    mockPrList([]);

    await pollReviewerRequests();

    expect(getTask(db, 'stale-review')).toBeUndefined();
    // Worktree row created alongside the draft must also go — otherwise the
    // workspaces list accumulates orphaned rows for every resolved PR review.
    const wt = db.prepare('SELECT id FROM worktrees WHERE id = ?').get(stale.worktree_id);
    expect(wt).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:deleted',
      payload: { taskId: 'stale-review' },
    });
  });

  it('leaves non-draft auto-review tasks alone when PR resolves', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      status: 'running',
      tmux_session: 'octomux-agent-running-review',
      pr_number: 99,
      pr_head_sha: 'sha-old',
      source: 'auto_review',
    });
    mockPrList([]);

    await pollReviewerRequests();

    // Still there — owner took ownership by running it
    expect(getTask(db, 'running-review')).toBeDefined();
  });

  it('does nothing when there are no tracked repos', async () => {
    mockPrList([]);

    await pollReviewerRequests();

    const prListCall = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'pr' && args?.[1] === 'list';
    });
    expect(prListCall).toBeUndefined();
  });

  it('tolerates gh failures per-repo without crashing', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    vi.mocked(execFile).mockImplementation(execFileFail('gh not found') as any);

    await expect(pollReviewerRequests()).resolves.not.toThrow();
    const autos = db.prepare(`SELECT id FROM tasks WHERE source = 'auto_review'`).all();
    expect(autos).toHaveLength(0);
  });

  it('uses --search review-requested:@me with --state open and cwd=repo', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([]);

    await pollReviewerRequests();

    const prListCall = vi.mocked(execFile).mock.calls.find((c: any[]) => {
      const args = c[1] as string[];
      return args?.[0] === 'pr' && args?.[1] === 'list';
    });
    expect(prListCall).toBeDefined();
    const callArgs = prListCall![1] as string[];
    expect(callArgs).toContain('--search');
    expect(callArgs).toContain('review-requested:@me');
    expect(callArgs).toContain('--state');
    expect(callArgs).toContain('open');
    const opts = prListCall![2] as { cwd: string };
    expect(opts.cwd).toBe(REPO);
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
