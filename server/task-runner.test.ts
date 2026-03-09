import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTestDb,
  insertTask,
  insertAgent,
  getTask,
  getAgents,
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

const { startTask, completeTask, cancelTask, addAgent, stopAgent, dispatchToWindow } =
  await import('./task-runner.js');
const { execFile, spawn } = await import('child_process');
const fs = await import('fs');

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
      { field: 'branch', expected: `agents/${DEFAULTS.task.id}` },
      { field: 'worktree', expected: `${DEFAULTS.task.repo_path}/.worktrees/${DEFAULTS.task.id}` },
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
    { name: 'launches claude', cmd: 'tmux', argsInclude: ['send-keys', 'claude'] },
    { name: 'dispatches prompt', cmd: 'tmux', argsInclude: ['paste-buffer'] },
  ];

  it.each(expectedShellCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('uses tmux load-buffer via spawn for prompt dispatch', async () => {
    insertTask(db);
    await startTask({ ...DEFAULTS.task } as Task);
    expect(spawn).toHaveBeenCalledWith('tmux', ['load-buffer', '-']);
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

  // ─── Shell commands ─────────────────────────────────────────────────────

  const addAgentShellCalls = [
    { name: 'creates tmux window', cmd: 'tmux', argsInclude: ['new-window'] },
    { name: 'queries window index', cmd: 'tmux', argsInclude: ['list-windows'] },
    { name: 'launches claude', cmd: 'tmux', argsInclude: ['send-keys', 'claude'] },
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

// ─── completeTask ─────────────────────────────────────────────────────────────

describe('completeTask', () => {
  it('marks all agents as stopped', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    await completeTask({ ...DEFAULTS.runningTask } as Task);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  // ─── Shell cleanup commands (table-driven) ─────────────────────────────

  const cleanupCalls = [
    { name: 'kills tmux session', cmd: 'tmux', argsInclude: ['kill-session'] },
    { name: 'removes worktree', cmd: 'git', argsInclude: ['worktree', 'remove'] },
  ];

  it.each(cleanupCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await completeTask({ ...DEFAULTS.runningTask } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  it('does NOT delete the branch', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await completeTask({ ...DEFAULTS.runningTask } as Task);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['branch', '-D'] }),
    ).toBeUndefined();
  });

  // ─── Null field handling (table-driven) ─────────────────────────────────

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
  ];

  it.each(nullFieldCases)('$name', async ({ overrides, shouldNotCall }) => {
    const task = { ...DEFAULTS.runningTask, ...overrides } as Task;
    insertTask(db, task);
    await completeTask(task);
    expect(findExecCall(vi.mocked(execFile), shouldNotCall)).toBeUndefined();
  });

  it('handles task with no agents gracefully', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await expect(completeTask({ ...DEFAULTS.runningTask } as Task)).resolves.not.toThrow();
  });
});

// ─── cancelTask ──────────────────────────────────────────────────────────────

describe('cancelTask', () => {
  it('marks all agents as stopped', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    await cancelTask({ ...DEFAULTS.runningTask } as Task);

    const agents = getAgents(db, DEFAULTS.task.id);
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  // ─── Shell cleanup commands (table-driven) ─────────────────────────────

  const cleanupCalls = [
    { name: 'kills tmux session', cmd: 'tmux', argsInclude: ['kill-session'] },
    { name: 'removes worktree', cmd: 'git', argsInclude: ['worktree', 'remove'] },
    { name: 'deletes branch', cmd: 'git', argsInclude: ['branch', '-D'] },
  ];

  it.each(cleanupCalls)('$name', async ({ cmd, argsInclude }) => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await cancelTask({ ...DEFAULTS.runningTask } as Task);
    expect(findExecCall(vi.mocked(execFile), { cmd, argsInclude })).toBeDefined();
  });

  // ─── Null field handling (table-driven) ─────────────────────────────────

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
    await cancelTask(task);
    expect(findExecCall(vi.mocked(execFile), shouldNotCall)).toBeUndefined();
  });

  it('handles task with no agents gracefully', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await expect(cancelTask({ ...DEFAULTS.runningTask } as Task)).resolves.not.toThrow();
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
  it('uses tmux load-buffer via spawn', async () => {
    await dispatchToWindow('test-session', 0, 'Hello');
    expect(spawn).toHaveBeenCalledWith('tmux', ['load-buffer', '-']);
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
