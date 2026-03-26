import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  insertUserTerminal,
  getUserTerminals,
  getTask,
  getAgents,
  getPermissionPrompts,
  findExecCall,
  countExecCalls,
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
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
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
}));

const {
  startTask,
  closeTask,
  deleteTask,
  addAgent,
  stopAgent,
  resumeTask,
  slugifyTitle,
  createUserTerminal,
  createShellTerminal,
  closeShellTerminal,
  cleanupLinkedSessions,
  cleanupOrphanedViewerSessions,
} = await import('./task-runner.js');
const { execFile } = await import('child_process');
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
  ];

  it.each(expectedShellCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { initial_prompt: 'Do the thing' });
    await startTask({ ...DEFAULTS.task, initial_prompt: 'Do the thing' } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('includes prompt via temp file in claude launch command', async () => {
    insertTask(db, { initial_prompt: 'Do the thing' });
    await startTask({ ...DEFAULTS.task, initial_prompt: 'Do the thing' } as Task);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys', 'Enter'],
    });
    expect(sendKeysCall).toBeDefined();
    const claudeCmd = (sendKeysCall![1] as string[]).find((a: string) =>
      a.includes('claude --session-id'),
    );
    expect(claudeCmd).toContain('$(cat ');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-prompt-'),
      'Do the thing',
    );
  });

  it('launches claude without prompt file when initial_prompt is null', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys', 'Enter'],
    });
    const claudeCmd = (sendKeysCall![1] as string[]).find((a: string) =>
      a.includes('claude --session-id'),
    );
    expect(claudeCmd).not.toContain('$(cat ');
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
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

  // ─── No-worktree mode ─────────────────────────────────────────────────

  describe('no_worktree mode', () => {
    const noWorktreeTask = { ...DEFAULTS.task, no_worktree: 1 } as Task;

    beforeEach(async () => {
      insertTask(db, { no_worktree: 1 });
      await startTask(noWorktreeTask);
    });

    it('sets worktree to repo_path', () => {
      const updated = getTask(db, DEFAULTS.task.id)!;
      expect(updated.worktree).toBe(DEFAULTS.task.repo_path);
    });

    it('sets branch to null', () => {
      const updated = getTask(db, DEFAULTS.task.id)!;
      expect(updated.branch).toBeNull();
    });

    it('sets status to running', () => {
      const updated = getTask(db, DEFAULTS.task.id)!;
      expect(updated.status).toBe('running');
    });

    it('does not create a git worktree', () => {
      expect(
        findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['worktree', 'add'] }),
      ).toBeUndefined();
    });

    it('does not create .worktrees directory', () => {
      expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalledWith(
        expect.stringContaining('.worktrees'),
        expect.anything(),
      );
    });

    it('creates tmux session with repo_path as cwd', () => {
      const call = findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['new-session'],
      });
      expect(call).toBeDefined();
      expect(call![1]).toContain(DEFAULTS.task.repo_path);
    });

    it('still creates an agent', () => {
      const agents = getAgents(db, DEFAULTS.task.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].label).toBe('Agent 1');
    });

    it('installs hook settings in repo_path', () => {
      expect(installHookSettings).toHaveBeenCalledWith(DEFAULTS.task.repo_path);
    });
  });
});

// ─── addAgent ─────────────────────────────────────────────────────────────────

describe('addAgent', () => {
  const runningTask = { ...DEFAULTS.runningTask } as Task;

  const agentLabelCases = [
    { name: 'first agent (none exist)', existingAgents: [], expectedLabel: 'Agent 1' },
    {
      name: 'second agent',
      existingAgents: [{}],
      expectedLabel: 'Agent 2',
    },
    {
      name: 'third agent',
      existingAgents: [{}, { id: 'agent-02', window_index: 1, label: 'Agent 2' }],
      expectedLabel: 'Agent 3',
    },
  ];

  it.each(agentLabelCases)(
    'creates $name with label "$expectedLabel"',
    async ({ existingAgents, expectedLabel }) => {
      insertTask(db, { ...DEFAULTS.runningTask });
      existingAgents.forEach((overrides) => insertAgent(db, overrides));

      const agent = await addAgent(runningTask);

      expect(agent.window_index).toBe(1);
      expect(agent.label).toBe(expectedLabel);
      expect(agent.status).toBe('running');
    },
  );

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

  it('includes prompt via temp file in claude launch command when provided', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await addAgent(runningTask, 'Write tests');

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: any[]) =>
          c[0] === 'tmux' &&
          (c[1] as string[]).includes('send-keys') &&
          (c[1] as string[]).some((a: string) => a.includes('claude --session-id')),
      );
    const claudeCmd = (sendKeysCalls[0][1] as string[]).find((a: string) =>
      a.includes('claude --session-id'),
    );
    expect(claudeCmd).toContain('$(cat ');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('.claude-prompt-'),
      'Write tests',
    );
  });

  it('launches claude without prompt file when no prompt provided', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await addAgent(runningTask);

    const sendKeysCalls = vi
      .mocked(execFile)
      .mock.calls.filter(
        (c: any[]) =>
          c[0] === 'tmux' &&
          (c[1] as string[]).includes('send-keys') &&
          (c[1] as string[]).some((a: string) => a.includes('claude --session-id')),
      );
    const claudeCmd = (sendKeysCalls[0][1] as string[]).find((a: string) =>
      a.includes('claude --session-id'),
    );
    expect(claudeCmd).not.toContain('$(cat ');
  });

  it('persists agent to database', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const agent = await addAgent(runningTask);

    const dbAgents = getAgents(db, DEFAULTS.task.id);
    expect(dbAgents).toHaveLength(1);
    expect(dbAgents[0].id).toBe(agent.id);
  });

  it('marks agent as stopped if async claude launch fails', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });

    // Make send-keys fail (but let new-window and list-windows succeed)
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else if (args.includes('list-windows')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('send-keys')) {
        cb(new Error('tmux send-keys failed'), null);
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agent = await addAgent(runningTask);
    // Flush the fire-and-forget async IIFE
    await new Promise((r) => setTimeout(r, 0));

    // Agent should be marked as stopped in DB
    const agents = getAgents(db, DEFAULTS.task.id);
    const dbAgent = agents.find((a) => a.id === agent.id)!;
    expect(dbAgent.status).toBe('stopped');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[addAgent]'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
    // Restore default execFile implementation for subsequent tests
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
});

// ─── closeTask ───────────────────────────────────────────────────────────────

describe('closeTask', () => {
  it('marks all agents as stopped and sets hook_activity to idle', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, { hook_activity: 'active' });
    insertAgent(db, {
      id: 'agent-02',
      window_index: 1,
      label: 'Agent 2',
      hook_activity: 'waiting',
    });

    await closeTask({ ...DEFAULTS.runningTask } as Task);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
    expect(agents.every((a) => a.hook_activity === 'idle')).toBe(true);
  });

  // ─── Shell cleanup commands (table-driven) ─────────────────────────────

  it('kills tmux session', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await closeTask({ ...DEFAULTS.runningTask } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBeDefined();
  });

  const closePreservedResources = [
    { name: 'worktree', cmd: 'git', argsInclude: ['worktree', 'remove'] },
    { name: 'branch', cmd: 'git', argsInclude: ['branch', '-D'] },
  ];

  it.each(closePreservedResources)(
    'does NOT remove $name (preserved for resume)',
    async ({ cmd, argsInclude }) => {
      insertTask(db, { ...DEFAULTS.runningTask });
      await closeTask({ ...DEFAULTS.runningTask } as Task);
      expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeUndefined();
    },
  );

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

  it('marks agent as stopped and sets hook_activity to idle', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db, { hook_activity: 'active' });

    await stopAgent({ ...DEFAULTS.runningTask } as Task, { ...DEFAULTS.agent } as Agent);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents[0].status).toBe('stopped');
    expect(agents[0].hook_activity).toBe('idle');
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

  const resumeFlagCases = [
    {
      name: 'session_id available',
      sessionId: 'session-abc-123',
      expectedFlag: '--resume',
      expectedId: 'session-abc-123',
    },
    { name: 'session_id null', sessionId: null, expectedFlag: '--continue', expectedId: undefined },
  ];

  it.each(resumeFlagCases)(
    'uses $expectedFlag when $name',
    async ({ sessionId, expectedFlag, expectedId }) => {
      insertTask(db, { ...closedTask });
      insertAgent(db, { status: 'stopped', claude_session_id: sessionId });

      await resumeTask(closedTask);

      const sendKeysCall = findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['send-keys'],
      });
      expect(sendKeysCall).toBeDefined();
      const args = sendKeysCall![1] as string[];
      const claudeCmd = args.find((a: string) => a.includes('claude'));
      expect(claudeCmd).toContain(expectedFlag);
      if (expectedId) expect(claudeCmd).toContain(expectedId);
    },
  );

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

// ─── cleanupLinkedSessions ──────────────────────────────────────────────────

describe('cleanupLinkedSessions', () => {
  it('kills all linked viewer sessions matching the prefix', async () => {
    const session = DEFAULTS.runningTask.tmux_session!;
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, {
          stdout: `${session}\n${session}-v-abc123\n${session}-v-def456\nother-session\n`,
          stderr: '',
        });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    await cleanupLinkedSessions(session);

    // Should kill exactly the two linked sessions
    expect(
      countExecCalls(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBe(2);
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['kill-session', '-t', `${session}-v-abc123`],
      }),
    ).toBeDefined();
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['kill-session', '-t', `${session}-v-def456`],
      }),
    ).toBeDefined();
  });

  it('does nothing when no linked sessions exist', async () => {
    const session = DEFAULTS.runningTask.tmux_session!;
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, { stdout: `${session}\nother-session\n`, stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    await cleanupLinkedSessions(session);

    expect(
      countExecCalls(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBe(0);
  });

  it('handles tmux not running gracefully', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: Function) => {
      cb(new Error('no server running'), null);
    }) as any);

    await expect(cleanupLinkedSessions('any-session')).resolves.not.toThrow();
  });
});

// ─── cleanupOrphanedViewerSessions ──────────────────────────────────────────

describe('cleanupOrphanedViewerSessions', () => {
  it('kills viewer sessions whose parent no longer exists', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, {
          stdout: [
            'octomux-agent-alive',
            'octomux-agent-alive-v-abc123', // parent alive — keep
            'octomux-agent-dead-v-def456', // parent dead — kill
            'octomux-agent-dead-v-ghi789', // parent dead — kill
            'unrelated-session',
          ].join('\n'),
          stderr: '',
        });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    await cleanupOrphanedViewerSessions();

    // Should kill 2 orphaned sessions (not the one with alive parent)
    expect(
      countExecCalls(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBe(2);
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['kill-session', '-t', 'octomux-agent-dead-v-def456'],
      }),
    ).toBeDefined();
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['kill-session', '-t', 'octomux-agent-dead-v-ghi789'],
      }),
    ).toBeDefined();
    // Should NOT kill the alive linked session
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'tmux',
        argsInclude: ['kill-session', '-t', 'octomux-agent-alive-v-abc123'],
      }),
    ).toBeUndefined();
  });

  it('does nothing when no orphaned sessions exist', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, { stdout: 'octomux-agent-task1\noctomux-agent-task1-v-abc\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    await cleanupOrphanedViewerSessions();

    expect(
      countExecCalls(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['kill-session'] }),
    ).toBe(0);
  });
});

// ─── closeTask linked session cleanup ───────────────────────────────────────

describe('closeTask linked session cleanup', () => {
  it('lists and kills linked sessions before killing main session', async () => {
    const session = DEFAULTS.runningTask.tmux_session!;
    const callOrder: string[] = [];

    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, { stdout: `${session}\n${session}-v-abc123\n`, stderr: '' });
      } else if (args.includes('kill-session')) {
        callOrder.push((args as string[]).find((a) => a.startsWith(session) || a === session)!);
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    insertTask(db, { ...DEFAULTS.runningTask });
    await closeTask({ ...DEFAULTS.runningTask } as Task);

    // Linked session killed before main session
    expect(callOrder).toEqual([`${session}-v-abc123`, session]);
  });
});

// ─── createShellTerminal ─────────────────────────────────────────────────────

describe('createShellTerminal', () => {
  it('creates tmux window and returns terminal record', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    expect(terminal.label).toBe('Terminal 1');
    expect(terminal.task_id).toBe(DEFAULTS.runningTask.id);
    expect(typeof terminal.window_index).toBe('number');
    expect(
      findExecCall(execFile as any, {
        cmd: 'tmux',
        argsInclude: ['new-window'],
      }),
    ).toBeTruthy();
  });

  it('auto-increments terminal labels', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    expect(terminal.label).toBe('Terminal 2');
  });

  it('inserts record into user_terminals table', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe(terminal.id);
  });
});

// ─── closeShellTerminal ──────────────────────────────────────────────────────

describe('closeShellTerminal', () => {
  it('kills tmux window and deletes DB record', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    await closeShellTerminal(DEFAULTS.runningTask as Task, DEFAULTS.userTerminal as any);
    expect(
      findExecCall(execFile as any, {
        cmd: 'tmux',
        argsInclude: ['kill-window'],
      }),
    ).toBeTruthy();
    expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
  });
});

// ─── closeTask — user terminal cleanup ──────────────────────────────────────

describe('closeTask — user terminal cleanup', () => {
  it('deletes user_terminals rows on close', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    await closeTask(DEFAULTS.runningTask as Task);
    expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
  });
});

// ─── resumeTask — user terminal cleanup ─────────────────────────────────────

describe('resumeTask — user terminal cleanup', () => {
  it('deletes user_terminals rows on resume', async () => {
    const closedTask = { ...DEFAULTS.runningTask, status: 'closed' as const };
    insertTask(db, closedTask);
    insertAgent(db, { status: 'stopped' });
    insertUserTerminal(db, { task_id: closedTask.id });
    await resumeTask(closedTask as Task);
    expect(getUserTerminals(db, closedTask.id)).toHaveLength(0);
  });
});

// ─── deleteTask linked session cleanup ──────────────────────────────────────

describe('deleteTask linked session cleanup', () => {
  it('lists and kills linked sessions before killing main session', async () => {
    const session = DEFAULTS.runningTask.tmux_session!;
    const callOrder: string[] = [];

    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: Function) => {
      if (args.includes('list-sessions')) {
        cb(null, { stdout: `${session}\n${session}-v-xyz789\n`, stderr: '' });
      } else if (args.includes('kill-session')) {
        callOrder.push((args as string[]).find((a) => a.startsWith(session) || a === session)!);
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    insertTask(db, { ...DEFAULTS.runningTask });
    await deleteTask({ ...DEFAULTS.runningTask } as Task);

    // Linked session killed before main session
    expect(callOrder).toEqual([`${session}-v-xyz789`, session]);
  });
});
