import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  getTask,
  getAgents,
  getPermissionPrompts,
  findExecCall,
  DEFAULTS,
} from './test-helpers.js';
import type { Task, Agent } from './types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

let nextWindowIndex = 0;

vi.mock('./hook-settings.js', () => ({
  installHookSettings: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], cb: Function) => {
    if (args.includes('display-message')) {
      cb(null, { stdout: String(nextWindowIndex), stderr: '' });
    } else if (args.includes('list-windows')) {
      cb(null, { stdout: String(nextWindowIndex), stderr: '' });
    } else if (args.includes('new-window')) {
      nextWindowIndex++;
      cb(null, { stdout: '', stderr: '' });
    } else {
      cb(null, { stdout: 'true', stderr: '' });
    }
  }),
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'close') cb(0);
    }),
  })),
}));

const {
  startTask,
  closeTask,
  deleteTask,
  addAgent,
  stopAgent,
  resumeTask,
  dispatchToWindow,
  slugifyTitle,
  createUserTerminal,
} = await import('./task-runner.js');
const { execFile, spawn } = await import('child_process');
const fs = await import('fs');
const { installHookSettings } = await import('./hook-settings.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  nextWindowIndex = 0;
});

afterEach(() => {
  db.close();
});

// ─── slugifyTitle ─────────────────────────────────────────────────────────────

describe('slugifyTitle', () => {
  const cases = [
    { title: 'Fix order validation', id: 'test-task-01', expected: 'fix-order-validation-test-t' },
    { title: 'Add NEW feature!!!', id: 'abc123defghi', expected: 'add-new-feature-abc123' },
    { title: '---leading---trailing---', id: 'xyz789', expected: 'leading-trailing-xyz789' },
    { title: 'a'.repeat(60), id: 'id1234', expected: 'a'.repeat(50) + '-id1234' },
    { title: 'Hello   World', id: '123456', expected: 'hello-world-123456' },
  ];

  it.each(cases)('slugifies "$title" → "$expected"', ({ title, id, expected }) => {
    expect(slugifyTitle(title, id)).toBe(expected);
  });
});

// ─── startTask ────────────────────────────────────────────────────────────────

describe('startTask', () => {
  // ─── Happy path DB state ────────────────────────────────────────────────

  describe('on success', () => {
    let updated: Task;
    let agents: Agent[];

    beforeEach(async () => {
      insertTask(db);
      await startTask({ ...DEFAULTS.task } as Task);
      updated = getTask(db, DEFAULTS.task.id)!;
      agents = getAgents(db, DEFAULTS.task.id);
    });

    const expectedFields = [
      { field: 'status', expected: 'running' },
      { field: 'tmux_session', expected: `octomux-agent-${DEFAULTS.task.id}` },
      { field: 'branch', expected: 'agents/fix-order-validation-test-t' },
      {
        field: 'worktree',
        expected: `${DEFAULTS.task.repo_path}/.worktrees/fix-order-validation-test-t`,
      },
    ];

    it.each(expectedFields)('sets $field to $expected', ({ field, expected }) => {
      expect((updated as any)[field]).toBe(expected);
    });

    it('creates Agent 1 record', () => {
      expect(agents).toHaveLength(1);
      expect(agents[0].label).toBe('Agent 1');
      expect(agents[0].window_index).toBe(0);
      expect(agents[0].status).toBe('running');
    });
  });

  // ─── Shell commands issued (table-driven) ──────────────────────────────

  const expectedShellCalls = [
    { name: 'validates git repo', cmd: 'git', argsInclude: ['rev-parse', '--is-inside-work-tree'] },
    { name: 'creates worktree', cmd: 'git', argsInclude: ['worktree', 'add'] },
    { name: 'creates tmux session', cmd: 'tmux', argsInclude: ['new-session'] },
    { name: 'queries window index', cmd: 'tmux', argsInclude: ['display-message'] },
    { name: 'launches claude', cmd: 'tmux', argsInclude: ['send-keys', 'Enter'] },
    { name: 'dispatches prompt', cmd: 'tmux', argsInclude: ['paste-buffer'] },
  ];

  it.each(expectedShellCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { initial_prompt: 'Do the thing' });
    await startTask({ ...DEFAULTS.task, initial_prompt: 'Do the thing' } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('uses tmux load-buffer with named buffer via spawn for prompt dispatch', async () => {
    insertTask(db, { initial_prompt: 'Do the thing' });
    await startTask({ ...DEFAULTS.task, initial_prompt: 'Do the thing' } as Task);
    const call = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'tmux' && (c[1] as string[]).includes('load-buffer'));
    expect(call).toBeDefined();
    expect(call![1] as string[]).toContain('-b');
  });

  it('skips prompt dispatch when initial_prompt is null', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['paste-buffer'] }),
    ).toBeUndefined();
    const loadBufferCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'tmux' && (c[1] as string[]).includes('load-buffer'));
    expect(loadBufferCall).toBeUndefined();
  });

  // ─── Custom branch and base branch ─────────────────────────────────────

  it('uses user-specified branch name when provided', async () => {
    insertTask(db, { branch: 'feat/my-feature' });
    await startTask({ ...DEFAULTS.task, branch: 'feat/my-feature' } as Task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.branch).toBe('feat/my-feature');

    const worktreeCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b', 'feat/my-feature'],
    });
    expect(worktreeCall).toBeDefined();
  });

  it('uses worktree directory matching branch name when provided', async () => {
    insertTask(db, { branch: 'feat/my-feature' });
    await startTask({ ...DEFAULTS.task, branch: 'feat/my-feature' } as Task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.worktree).toBe(`${DEFAULTS.task.repo_path}/.worktrees/feat/my-feature`);
  });

  it('passes base_branch as start point for worktree add', async () => {
    insertTask(db, { base_branch: 'develop' });
    await startTask({ ...DEFAULTS.task, base_branch: 'develop' } as Task);

    const worktreeCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', 'develop'],
    });
    expect(worktreeCall).toBeDefined();
  });

  it('does not append base branch when base_branch is null', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);

    const worktreeCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add'],
    });
    expect(worktreeCall).toBeDefined();
    // The args should end with the -b <branch> without an extra base branch arg
    const args = worktreeCall![1] as string[];
    const branchIdx = args.indexOf('-b');
    // After -b comes the branch name, nothing after that
    expect(args.length).toBe(branchIdx + 2);
  });

  // ─── Settings copy ─────────────────────────────────────────────────────

  it('copies .claude/settings.local.json when it exists', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);
    // existsSync is called for repo_path and settings file
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled();
  });

  it('skips settings copy when file does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // Only repo path exists, not settings
      return !String(p).includes('settings.local.json');
    });

    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
  });

  // ─── Error cases (table-driven) ────────────────────────────────────────

  const errorCases = [
    {
      name: 'repo path does not exist',
      setup: () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
      },
      errorContains: 'does not exist',
    },
    {
      name: 'not a git repo',
      setup: () => {
        vi.mocked(execFile).mockImplementationOnce((_cmd: any, _args: any, cb: any) => {
          cb(new Error('not a git repository'), null);
          return undefined as any;
        });
      },
      errorContains: 'not a git repository',
    },
  ];

  it.each(errorCases)('sets error when $name', async ({ setup, errorContains }) => {
    setup();
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.status).toBe('error');
    expect(updated.error).toContain(errorContains);
  });
});

// ─── addAgent ─────────────────────────────────────────────────────────────────

describe('addAgent', () => {
  const runningTask = { ...DEFAULTS.runningTask } as Task;

  it('creates first agent when none exist', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const agent = await addAgent(runningTask);

    // Window index comes from tmux list-windows after new-window
    expect(agent.window_index).toBe(1);
    expect(agent.label).toBe('Agent 1');
    expect(agent.status).toBe('running');
  });

  it('creates second agent with correct label', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const agent = await addAgent(runningTask);

    // Window index comes from tmux, label increments based on DB count
    expect(agent.window_index).toBe(1);
    expect(agent.label).toBe('Agent 2');
  });

  it('creates third agent with correct label', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    const agent = await addAgent(runningTask);

    expect(agent.window_index).toBe(1);
    expect(agent.label).toBe('Agent 3');
  });

  it('reuses window index after agent is stopped', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2', status: 'stopped' });
    insertAgent(db, { id: 'agent-03', window_index: 2, label: 'Agent 3', status: 'stopped' });

    const agent = await addAgent(runningTask);

    expect(agent.window_index).toBe(1);
    expect(agent.label).toBe('Agent 2');
  });

  // ─── Shell commands ─────────────────────────────────────────────────────

  const addAgentShellCalls = [
    { name: 'creates tmux window', cmd: 'tmux', argsInclude: ['new-window'] },
    { name: 'queries window index', cmd: 'tmux', argsInclude: ['list-windows'] },
    { name: 'launches claude', cmd: 'tmux', argsInclude: ['send-keys', 'Enter'] },
  ];

  it.each(addAgentShellCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await addAgent(runningTask);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('dispatches prompt when provided', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await addAgent(runningTask, 'Write tests');
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['paste-buffer'] }),
    ).toBeDefined();
  });

  it('does not dispatch when no prompt provided', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await addAgent(runningTask);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['paste-buffer'] }),
    ).toBeUndefined();
  });

  it('persists agent to database', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const agent = await addAgent(runningTask);

    const dbAgents = getAgents(db, DEFAULTS.task.id);
    expect(dbAgents).toHaveLength(1);
    expect(dbAgents[0].id).toBe(agent.id);
  });
});

// ─── closeTask ───────────────────────────────────────────────────────────────

describe('closeTask', () => {
  it('marks all agents as stopped', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    await closeTask({ ...DEFAULTS.runningTask } as Task);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  // ─── Shell cleanup commands (table-driven) ─────────────────────────────

  it('kills tmux session', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await closeTask({ ...DEFAULTS.runningTask } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBeDefined();
  });

  it('does NOT remove worktree (preserved for resume)', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await closeTask({ ...DEFAULTS.runningTask } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['worktree', 'remove'] }),
    ).toBeUndefined();
  });

  it('does NOT delete the branch', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await closeTask({ ...DEFAULTS.runningTask } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['branch', '-D'] }),
    ).toBeUndefined();
  });

  it('skips tmux kill when tmux_session is null', async () => {
    const task = { ...DEFAULTS.runningTask, tmux_session: null } as Task;
    insertTask(db, task);
    await closeTask(task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBeUndefined();
  });

  it('handles task with no agents gracefully', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await expect(closeTask({ ...DEFAULTS.runningTask } as Task)).resolves.not.toThrow();
  });
});

// ─── deleteTask ───────────────────────────────────────────────────────────────

describe('deleteTask', () => {
  const deleteCalls = [
    { name: 'kills tmux session', cmd: 'tmux', argsInclude: ['kill-session'] },
    { name: 'removes worktree', cmd: 'git', argsInclude: ['worktree', 'remove'] },
    { name: 'deletes branch', cmd: 'git', argsInclude: ['branch', '-D'] },
  ];

  it.each(deleteCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await deleteTask({ ...DEFAULTS.runningTask } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  const nullFieldCases = [
    {
      name: 'skips tmux kill when tmux_session is null',
      overrides: { tmux_session: null },
      shouldNotCall: { cmd: 'tmux', argsInclude: ['kill-session'] },
    },
    {
      name: 'skips worktree remove when worktree is null',
      overrides: { worktree: null },
      shouldNotCall: { cmd: 'git', argsInclude: ['worktree', 'remove'] },
    },
    {
      name: 'skips branch delete when branch is null',
      overrides: { branch: null },
      shouldNotCall: { cmd: 'git', argsInclude: ['branch', '-D'] },
    },
  ];

  it.each(nullFieldCases)('$name', async ({ overrides, shouldNotCall }) => {
    const task = { ...DEFAULTS.runningTask, ...overrides } as Task;
    insertTask(db, task);
    await deleteTask(task);
    expect(findExecCall(vi.mocked(execFile), shouldNotCall)).toBeUndefined();
  });
});

// ─── stopAgent ────────────────────────────────────────────────────────────────

describe('stopAgent', () => {
  it('kills the specific tmux window', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    await stopAgent({ ...DEFAULTS.runningTask } as Task, { ...DEFAULTS.agent } as Agent);

    const call = findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-window'] });
    expect(call).toBeDefined();
    expect(call![1]).toContain(
      `${DEFAULTS.runningTask.tmux_session}:${DEFAULTS.agent.window_index}`,
    );
  });

  it('marks agent as stopped in database', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    await stopAgent({ ...DEFAULTS.runningTask } as Task, { ...DEFAULTS.agent } as Agent);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents[0].status).toBe('stopped');
  });

  it('does not affect other agents', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    await stopAgent({ ...DEFAULTS.runningTask } as Task, { ...DEFAULTS.agent } as Agent);

    const agents = getAgents(db, DEFAULTS.task.id);
    const other = agents.find((a) => a.id === 'agent-02')!;
    expect(other.status).toBe('running');
  });
});

// ─── dispatchToWindow ─────────────────────────────────────────────────────────

describe('dispatchToWindow', () => {
  it('uses tmux load-buffer with named buffer via spawn', async () => {
    await dispatchToWindow('test-session', 0, 'Hello');
    const call = vi
      .mocked(spawn)
      .mock.calls.find((c) => c[0] === 'tmux' && (c[1] as string[]).includes('load-buffer'));
    expect(call).toBeDefined();
    expect(call![1] as string[]).toContain('-b');
  });

  it('writes text + newline to stdin', async () => {
    await dispatchToWindow('test-session', 0, 'Hello');
    const spawnCall = vi.mocked(spawn).mock.results[0].value;
    expect(spawnCall.stdin.write).toHaveBeenCalledWith('Hello\n');
    expect(spawnCall.stdin.end).toHaveBeenCalled();
  });

  it('pastes buffer to correct target', async () => {
    await dispatchToWindow('my-session', 2, 'text');
    const call = findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['paste-buffer'] });
    expect(call![1]).toContain('my-session:2');
  });

  it('sends Enter key after pasting buffer', async () => {
    await dispatchToWindow('my-session', 2, 'text');
    const call = findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['send-keys'] });
    expect(call).toBeTruthy();
    expect(call![1]).toContain('my-session:2');
    expect(call![1]).toContain('Enter');
  });

  it('rejects when load-buffer exits non-zero', async () => {
    vi.mocked(spawn).mockReturnValueOnce({
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') cb(1);
      }),
    } as any);

    await expect(dispatchToWindow('s', 0, 'text')).rejects.toThrow(
      'tmux load-buffer exited with code 1',
    );
  });
});

// ─── resumeTask ──────────────────────────────────────────────────────────────

describe('resumeTask', () => {
  const closedTask = {
    ...DEFAULTS.runningTask,
    status: 'closed' as const,
  } as Task;

  it('sets status to setting_up then running on success', async () => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.status).toBe('running');
  });

  it('clears error field on resume', async () => {
    insertTask(db, { ...closedTask, status: 'error', error: 'Previous error' });
    insertAgent(db, { status: 'stopped' });

    await resumeTask({ ...closedTask, status: 'error' as any } as Task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.error).toBeNull();
  });

  it('marks stopped agents as running', async () => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2', status: 'stopped' });

    await resumeTask(closedTask);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents.every((a) => a.status === 'running')).toBe(true);
  });

  // ─── Shell commands (table-driven) ──────────────────────────────────────

  const resumeShellCalls = [
    { name: 'kills stale tmux session', cmd: 'tmux', argsInclude: ['kill-session'] },
    { name: 'creates fresh tmux session', cmd: 'tmux', argsInclude: ['new-session'] },
    { name: 'launches claude in window', cmd: 'tmux', argsInclude: ['send-keys', 'Enter'] },
  ];

  it.each(resumeShellCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('uses --resume with claude_session_id when available', async () => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped', claude_session_id: 'session-abc-123' });

    await resumeTask(closedTask);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys'],
    });
    expect(sendKeysCall).toBeDefined();
    const args = sendKeysCall![1] as string[];
    const claudeCmd = args.find((a: string) => a.includes('claude'));
    expect(claudeCmd).toContain('--resume');
    expect(claudeCmd).toContain('session-abc-123');
  });

  it('uses --continue when claude_session_id is null', async () => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped', claude_session_id: null });

    await resumeTask(closedTask);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys'],
    });
    const args = sendKeysCall![1] as string[];
    const claudeCmd = args.find((a: string) => a.includes('claude'));
    expect(claudeCmd).toContain('--continue');
  });

  it('creates new windows for agents after the first', async () => {
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2', status: 'stopped' });

    await resumeTask(closedTask);

    // Should create exactly one new-window (for second agent; first reuses session window)
    const newWindowCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: any[]) => c[0] === 'tmux' && (c[1] as string[]).includes('new-window'),
      );
    expect(newWindowCalls).toHaveLength(1);
  });

  it('sets error status on failure', async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new Error('tmux not found');
    });

    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.status).toBe('error');
    expect(updated.error).toContain('tmux not found');
  });

  it('resets user_window_index to null on resume', async () => {
    insertTask(db, { ...closedTask, user_window_index: 3 });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.user_window_index).toBeNull();
  });
});

// ─── createUserTerminal ──────────────────────────────────────────────────────

describe('createUserTerminal', () => {
  const runningTask = { ...DEFAULTS.runningTask } as Task;

  beforeEach(() => {
    // Restore the default execFile mock in case a previous test overrode it
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('display-message')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('list-windows')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: 'true', stderr: '' });
      }
    }) as any);
  });

  it('creates tmux window and returns window index', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const index = await createUserTerminal(runningTask);

    expect(index).toBe(1);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['new-window'] }),
    ).toBeDefined();
  });

  it('sends nvim launch command to the new window', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await createUserTerminal(runningTask);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys', 'nvim .', 'Enter'],
    });
    expect(sendKeysCall).toBeDefined();
  });

  it('stores user_window_index in the database', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await createUserTerminal(runningTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.user_window_index).toBe(1);
  });

  it('returns existing index without creating new window when already set', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, user_window_index: 5 });
    const index = await createUserTerminal({
      ...runningTask,
      user_window_index: 5,
    } as Task);

    expect(index).toBe(5);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['new-window'] }),
    ).toBeUndefined();
  });
});

// ─── hook integration ─────────────────────────────────────────────────────────

describe('hook integration', () => {
  it('startTask installs hook settings in worktree', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);

    expect(vi.mocked(installHookSettings)).toHaveBeenCalledWith(
      expect.stringContaining('.worktrees/'),
    );
  });

  it('closeTask resolves all pending permission prompts', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertPermissionPrompt(db, {
      id: 'pp_001',
      task_id: DEFAULTS.task.id,
      agent_id: DEFAULTS.agent.id,
      status: 'pending',
    });
    insertPermissionPrompt(db, {
      id: 'pp_002',
      task_id: DEFAULTS.task.id,
      agent_id: DEFAULTS.agent.id,
      status: 'pending',
    });

    await closeTask({ ...DEFAULTS.runningTask } as Task);

    const prompts = getPermissionPrompts(db, DEFAULTS.task.id);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.status === 'resolved')).toBe(true);
    expect(prompts.every((p) => p.resolved_at !== null)).toBe(true);
  });

  it('stopAgent resolves pending prompts for that agent only', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    insertPermissionPrompt(db, {
      id: 'pp_001',
      task_id: DEFAULTS.task.id,
      agent_id: DEFAULTS.agent.id,
      status: 'pending',
    });
    insertPermissionPrompt(db, {
      id: 'pp_002',
      task_id: DEFAULTS.task.id,
      agent_id: 'agent-02',
      status: 'pending',
    });

    await stopAgent({ ...DEFAULTS.runningTask } as Task, { ...DEFAULTS.agent } as Agent);

    const prompts = getPermissionPrompts(db, DEFAULTS.task.id);
    const agent1Prompt = prompts.find((p) => p.agent_id === DEFAULTS.agent.id)!;
    const agent2Prompt = prompts.find((p) => p.agent_id === 'agent-02')!;

    expect(agent1Prompt.status).toBe('resolved');
    expect(agent1Prompt.resolved_at).not.toBeNull();
    expect(agent2Prompt.status).toBe('pending');
    expect(agent2Prompt.resolved_at).toBeNull();
  });

  it('resumeTask generates session ID for --continue agents', async () => {
    const closedTask = { ...DEFAULTS.runningTask, status: 'closed' as const } as Task;
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped', claude_session_id: null });

    await resumeTask(closedTask);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents[0].claude_session_id).toBeTruthy();
    // UUID format check
    expect(agents[0].claude_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('resumeTask installs hook settings', async () => {
    const closedTask = { ...DEFAULTS.runningTask, status: 'closed' as const } as Task;
    insertTask(db, { ...closedTask });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    expect(vi.mocked(installHookSettings)).toHaveBeenCalledWith(DEFAULTS.runningTask.worktree);
  });

  it('addAgent returns hook_activity fields', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const agent = await addAgent({ ...DEFAULTS.runningTask } as Task);

    expect(agent.hook_activity).toBe('active');
    expect(agent.hook_activity_updated_at).toBeNull();
  });
});
