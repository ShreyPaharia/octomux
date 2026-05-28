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
  startTask: vi.fn(async () => undefined),
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
const { closeTask, startTask } = await import('./task-runner.js');
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
    { taskState: 'running' as const, expectedState: 'idle' as const, expectedError: undefined },
    {
      taskState: 'setting_up' as const,
      expectedState: 'error' as const,
      expectedError: 'Setup interrupted',
    },
  ];

  describe.each(sessionDeathCases)(
    'when $taskState task session dies',
    ({ taskState, expectedState, expectedError }) => {
      beforeEach(() => {
        vi.mocked(execFile).mockImplementation(deadSessionMock as any);
      });

      it(`sets task runtime_state to ${expectedState}`, async () => {
        insertTask(db, { ...DEFAULTS.runningTask, runtime_state: taskState });
        insertAgent(db);

        await pollStatuses();

        const task = getTask(db, DEFAULTS.task.id)!;
        expect(task.runtime_state).toBe(expectedState);
        if (expectedError) expect(task.error).toBe(expectedError);
      });

      it('marks all agents as stopped', async () => {
        insertTask(db, { ...DEFAULTS.runningTask, runtime_state: taskState });
        insertAgent(db);
        insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

        await pollStatuses();

        const agents = getAgents(db, DEFAULTS.task.id);
        expect(agents.every((a) => a.status === 'stopped')).toBe(true);
      });

      it('sets hook_activity to idle for all agents', async () => {
        insertTask(db, { ...DEFAULTS.runningTask, runtime_state: taskState });
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
    expect(task.runtime_state).toBe('running');
  });

  // ─── Status filtering (table-driven) ──────────────────────────────────────

  const ignoredStates = ['idle', 'error'] as const;

  it.each(ignoredStates)('ignores tasks with runtime_state "%s"', async (state) => {
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: state });

    vi.mocked(execFile).mockImplementation(deadSessionMock as any);

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.runtime_state).toBe(state);
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
    expect(getTask(db, DEFAULTS.task.id)!.runtime_state).toBe('running');
    expect(getTask(db, 'task-02')!.runtime_state).toBe('running');
  });

  it('does not mark "setting_up" as Setup interrupted when tmux_session is null', async () => {
    // Reproduces the race where startTask has written runtime_state='setting_up' but
    // hasn't yet created the tmux session. Poller must leave the task alone.
    insertTask(db, { ...DEFAULTS.runningTask, runtime_state: 'setting_up', tmux_session: null });
    vi.mocked(execFile).mockImplementation(deadSessionMock as any);

    await pollStatuses();

    const task = getTask(db, DEFAULTS.task.id)!;
    expect(task.runtime_state).toBe('setting_up');
    expect(task.error).toBeNull();
  });
});

// ─── ensureHooksInstalled ───────────────────────────────────────────────────

describe('ensureHooksInstalled', () => {
  it('installs hooks for running tasks with worktrees', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, {
      id: 'a1',
      task_id: DEFAULTS.runningTask.id,
      hook_token: 'tok-1',
    });

    await ensureHooksInstalled();

    expect(installHookSettings).toHaveBeenCalledWith(
      DEFAULTS.runningTask.worktree,
      DEFAULTS.runningTask.harness_id,
      'tok-1',
    );
  });

  it('installs hooks for multiple running tasks', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, { id: 'a1', task_id: DEFAULTS.runningTask.id, hook_token: 'tok-1' });
    insertTask(db, {
      ...DEFAULTS.runningTask,
      id: 'task-02',
      worktree: '/tmp/test-repo/.worktrees/task-02',
    });
    insertAgent(db, { id: 'a2', task_id: 'task-02', hook_token: 'tok-2' });

    await ensureHooksInstalled();

    expect(installHookSettings).toHaveBeenCalledTimes(2);
  });

  const skipCases = [
    { name: 'non-running tasks', overrides: { runtime_state: 'idle' as const } },
    { name: 'tasks without worktree', overrides: { worktree: null } },
  ];

  it.each(skipCases)('skips $name', async ({ overrides }) => {
    insertTask(db, { ...DEFAULTS.runningTask, ...overrides });

    await ensureHooksInstalled();

    expect(installHookSettings).not.toHaveBeenCalled();
  });

  it('skips tasks with no tokenized agent', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    // No agents inserted — task is in running state but nobody has a token yet.

    await ensureHooksInstalled();

    expect(installHookSettings).not.toHaveBeenCalled();
  });

  it('does not crash when installHookSettings throws', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, { id: 'a1', task_id: DEFAULTS.runningTask.id, hook_token: 'tok-1' });
    vi.mocked(installHookSettings).mockImplementation(() => {
      throw new Error('permission denied');
    });

    await expect(ensureHooksInstalled()).resolves.not.toThrow();
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
      const cb = findCallback(...mockArgs)!;
      const cmd = mockArgs[0] as string;
      const args = mockArgs[1] as string[];
      if (cmd === 'git' && args?.includes('remote') && args?.includes('get-url')) {
        cb(null, { stdout: 'git@github.com:org/repo.git\n', stderr: '' });
      } else if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'graphql') {
        cb(null, {
          stdout: JSON.stringify({
            data: {
              pr0: {
                pullRequests: {
                  nodes: [{ number: 99, url: 'https://github.com/org/repo/pull/99' }],
                },
              },
            },
          }),
          stderr: '',
        });
      } else {
        cb(null, { stdout: '', stderr: '' });
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

  const prPollStates = [
    { state: 'running', shouldPoll: true },
    { state: 'idle', shouldPoll: true },
    { state: 'setting_up', shouldPoll: false },
    { state: 'error', shouldPoll: false },
  ] as const;

  it.each(prPollStates)(
    'runtime_state "$state" → shouldPoll=$shouldPoll',
    async ({ state, shouldPoll }) => {
      insertTask(db, { ...DEFAULTS.runningTask, runtime_state: state });

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
  /**
   * Mock both `git remote get-url origin` (so the test repo resolves to org/repo)
   * and the single `gh api graphql` PR-state query. `prStates` maps alias index
   * to PR state (e.g. { pr0: 'MERGED' }).
   */
  function mockPrStates(prStates: Record<string, string>) {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args)!;
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (cmd === 'git' && cmdArgs?.includes('remote') && cmdArgs?.includes('get-url')) {
        cb(null, { stdout: 'git@github.com:org/repo.git\n', stderr: '' });
      } else if (cmd === 'gh' && cmdArgs?.[0] === 'api' && cmdArgs?.[1] === 'graphql') {
        const data: Record<string, { pullRequest: { state: string } }> = {};
        for (const [alias, state] of Object.entries(prStates)) {
          data[alias] = { pullRequest: { state } };
        }
        cb(null, { stdout: JSON.stringify({ data }), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });
  }

  it('closes task when PR is merged', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });
    mockPrStates({ pr0: 'MERGED' });

    await checkMergedPRs();

    expect(closeTask).toHaveBeenCalledWith(expect.objectContaining({ id: DEFAULTS.task.id }));
  });

  it('does not close task when PR is open', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });
    mockPrStates({ pr0: 'OPEN' });

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

  it('issues one gh api graphql call with aliased PR queries for all running tasks', async () => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
    });
    mockPrStates({ pr0: 'OPEN' });

    await checkMergedPRs();

    const ghCalls = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'gh');
    expect(ghCalls).toHaveLength(1);
    const callArgs = ghCalls[0][1] as string[];
    expect(callArgs[0]).toBe('api');
    expect(callArgs[1]).toBe('graphql');
    const queryField = callArgs.find((a) => a.startsWith('query='));
    expect(queryField).toBeDefined();
    expect(queryField).toContain('pr0:');
    expect(queryField).toContain('owner: "org"');
    expect(queryField).toContain('name: "repo"');
    expect(queryField).toContain('pullRequest(number: 42)');
  });

  const nonRunningStates = ['idle', 'error', 'setting_up'] as const;

  it.each(nonRunningStates)('skips tasks with runtime_state "%s"', async (state) => {
    insertTask(db, {
      ...DEFAULTS.runningTask,
      runtime_state: state,
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

  /**
   * Install an execFile mock that returns the given PR list for the global
   * `gh api graphql` search call. Test PRs are URL-derived to belong to `org/repo`,
   * which the git-remote mock resolves to the test REPO.
   */
  function mockPrList(prs: Array<Record<string, unknown>>) {
    const searchNodes = prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      headRefOid: pr.headRefOid,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      repository: { nameWithOwner: 'org/repo' },
      reviewRequests: {
        nodes: ((pr.reviewRequests as Array<{ login?: string }> | undefined) ?? []).map((rr) => ({
          requestedReviewer: { __typename: 'User', login: rr.login },
        })),
      },
    }));
    const graphqlBody = JSON.stringify({ data: { search: { nodes: searchNodes } } });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = findCallback(...args)!;
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (cmd === 'gh' && cmdArgs?.[0] === 'api' && cmdArgs?.[1] === 'graphql') {
        cb(null, { stdout: graphqlBody, stderr: '' });
      } else if (cmd === 'git' && cmdArgs?.includes('remote') && cmdArgs?.includes('get-url')) {
        cb(null, { stdout: 'git@github.com:org/repo.git\n', stderr: '' });
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

    // Should not have shelled out to gh at all
    const ghCall = vi.mocked(execFile).mock.calls.find((c: any[]) => c[0] === 'gh');
    expect(ghCall).toBeUndefined();
  });

  it('creates a draft auto-review task when owner is a reviewer', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([makePR()]);

    await pollReviewerRequests();

    const created = db
      .prepare(
        `SELECT t.id, t.runtime_state, t.title, t.pr_number, t.pr_head_sha, t.initial_prompt,
                w.branch AS branch, w.base_branch AS base_branch
           FROM tasks t LEFT JOIN worktrees w ON t.worktree_id = w.id
          WHERE t.source = 'auto_review'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(created).toBeDefined();
    expect(created!.runtime_state).toBe('idle');
    expect(created!.pr_number).toBe(42);
    expect(created!.pr_head_sha).toBe('sha-aaa');
    expect(created!.base_branch).toBe('main');
    expect((created!.branch as string).startsWith('review/')).toBe(true);
    expect(created!.branch).toContain('pr-42');
    expect(created!.title).toContain('#42');
    expect((created!.initial_prompt as string).startsWith('/review-orchestrator')).toBe(true);
    expect(created!.initial_prompt).toContain('https://github.com');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:created',
      payload: { taskId: created!.id },
    });
  });

  it('auto-starts the task after creating it', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([makePR()]);

    await pollReviewerRequests();

    const created = db.prepare(`SELECT id FROM tasks WHERE source = 'auto_review'`).get() as {
      id: string;
    };
    expect(created).toBeDefined();
    expect(startTask).toHaveBeenCalledTimes(1);
    const calledWith = vi.mocked(startTask).mock.calls[0][0];
    expect((calledWith as { id: string }).id).toBe(created.id);
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
      runtime_state: 'idle',
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
      runtime_state: 'idle',
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
      runtime_state: 'idle',
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
      runtime_state: 'running',
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

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
      );

    expect(sendKeysCalls).toHaveLength(2);

    const literalArgs = sendKeysCalls[0][1] as string[];
    expect(literalArgs).toContain('-t');
    expect(literalArgs).toContain('octomux-agent-running-review:0');
    expect(literalArgs).toContain('-l');
    const message = literalArgs.find((a) => a.includes('Re-review requested'));
    expect(message).toBeDefined();
    expect(message).toContain('sha-new');
    expect(message).toContain('#42');

    const enterArgs = sendKeysCalls[1][1] as string[];
    expect(enterArgs).toContain('-t');
    expect(enterArgs).toContain('octomux-agent-running-review:0');
    expect(enterArgs).toContain('Enter');

    // SHA recorded so we don't re-nudge on the next tick
    const task = getTask(db, 'running-review')!;
    expect(task.pr_head_sha).toBe('sha-new');
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: 'running-review' },
    });
  });

  it('git-fetches and checks out the new head before nudging the agent', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      worktree: '/wt',
      runtime_state: 'running',
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

    const gitCalls = vi
      .mocked(execFile)
      .mock.calls.filter((c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]));
    const fetchIdx = gitCalls.findIndex(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('fetch'),
    );
    const checkoutIdx = gitCalls.findIndex(
      (c) =>
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('checkout') &&
        (c[1] as string[]).includes('sha-new'),
    );
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(fetchIdx);

    // Both git calls precede the first tmux send-keys (allCalls order).
    const allCalls = vi.mocked(execFile).mock.calls;
    const sendKeysAt = allCalls.findIndex(
      (c: unknown[]) =>
        c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
    );
    const checkoutAt = allCalls.findIndex(
      (c: unknown[]) =>
        c[0] === 'git' &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('checkout') &&
        (c[1] as string[]).includes('sha-new'),
    );
    expect(sendKeysAt).toBeGreaterThan(checkoutAt);
  });

  it('falls back to full re-review when prev head is unreachable from new head', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      worktree: '/wt',
      runtime_state: 'running',
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

    // PR list mock + override merge-base --is-ancestor to fail.
    const searchNodes = [
      {
        number: 42,
        title: 'Add thing',
        url: 'https://github.com/org/repo/pull/42',
        author: { login: 'teammate' },
        headRefOid: 'sha-new',
        headRefName: 'feat/thing',
        baseRefName: 'main',
        repository: { nameWithOwner: 'org/repo' },
        reviewRequests: {
          nodes: [{ requestedReviewer: { __typename: 'User', login: OWNER } }],
        },
      },
    ];
    const graphqlBody = JSON.stringify({ data: { search: { nodes: searchNodes } } });

    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = findCallback(...args)!;
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (cmd === 'gh' && cmdArgs?.[0] === 'api' && cmdArgs?.[1] === 'graphql') {
        cb(null, { stdout: graphqlBody, stderr: '' });
      } else if (cmd === 'git' && cmdArgs?.includes('remote') && cmdArgs?.includes('get-url')) {
        cb(null, { stdout: 'git@github.com:org/repo.git\n', stderr: '' });
      } else if (cmd === 'git' && cmdArgs?.includes('merge-base')) {
        cb(new Error('not an ancestor'));
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as unknown as ReturnType<typeof execFile>;
    });

    await pollReviewerRequests();

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
      );
    const literal = sendKeysCalls[0][1] as string[];
    const message = literal.find((a) => a.startsWith('Re-review'));
    expect(message).toBeDefined();
    expect(message).toMatch(/previous_head_unreachable=true/);
  });

  it('does not re-nudge a running review when head SHA is unchanged', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'running-review',
      repo_path: REPO,
      runtime_state: 'running',
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

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
      );
    expect(sendKeysCalls).toHaveLength(0);
  });

  it('does not nudge owner-created running tasks', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    insertTask(db, {
      id: 'manual-running',
      repo_path: REPO,
      runtime_state: 'running',
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

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
      );
    expect(sendKeysCalls).toHaveLength(0);
    // SHA untouched
    expect(getTask(db, 'manual-running')!.pr_head_sha).toBe('sha-old');
  });

  it('deletes draft auto-review tasks when the reviewer request is resolved', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    const stale = insertTask(db, {
      id: 'stale-review',
      repo_path: REPO,
      runtime_state: 'idle',
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
      runtime_state: 'running',
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

  it('uses a single global gh api graphql search for review-requested PRs', async () => {
    insertTask(db, { id: 'seed', repo_path: REPO });
    mockPrList([]);

    await pollReviewerRequests();

    // Exactly one gh call, and it's the graphql search (not per-repo `pr list`).
    const ghCalls = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'gh');
    expect(ghCalls).toHaveLength(1);
    const callArgs = ghCalls[0][1] as string[];
    expect(callArgs[0]).toBe('api');
    expect(callArgs[1]).toBe('graphql');
    // The query payload is passed via `-f query=...`
    const queryField = callArgs.find((a) => a.startsWith('query='));
    expect(queryField).toBeDefined();
    expect(queryField).toContain('review-requested:@me');
    expect(queryField).toContain('is:open');
  });
});

// ─── sweepStuckReviewRuns ────────────────────────────────────────────────────

describe('sweepStuckReviewRuns', () => {
  it('marks a review_run failed after 15min with no walkthrough and no comments', async () => {
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review')`,
    ).run();
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at)
       VALUES ('r1', 't1', 'sha', 'running', datetime('now', '-16 minutes'))`,
    ).run();

    const { sweepStuckReviewRuns } = await import('./poller.js');
    await sweepStuckReviewRuns();
    const row = db.prepare(`SELECT status, error FROM review_runs WHERE id = 'r1'`).get() as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/timeout/);
  });

  it('leaves a fresh review_run alone', async () => {
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
       VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review')`,
    ).run();
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at)
       VALUES ('r1', 't1', 'sha', 'running', datetime('now', '-2 minutes'))`,
    ).run();
    const { sweepStuckReviewRuns } = await import('./poller.js');
    await sweepStuckReviewRuns();
    const row = db.prepare(`SELECT status FROM review_runs WHERE id = 'r1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('running');
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
