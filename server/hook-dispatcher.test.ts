import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import type { HookEnvelope } from './hook-types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSpawn = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockAccessSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCreateWriteStream = vi.fn();
const mockStatSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    accessSync: mockAccessSync,
    mkdirSync: mockMkdirSync,
    createWriteStream: mockCreateWriteStream,
    statSync: mockStatSync,
    unlinkSync: mockUnlinkSync,
    readFileSync: mockReadFileSync,
    constants: { X_OK: 1 },
  },
}));

// ─── Fake Process ─────────────────────────────────────────────────────────────

/**
 * Creates a fake child_process that fires close/error automatically when
 * the test registers a listener for that event (synchronously on next
 * microtask tick, safely after the caller sets up all listeners).
 */
function makeAutoProc({
  exitCode = 0,
  spawnError,
}: { exitCode?: number; spawnError?: Error } = {}) {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const proc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      // Fire the relevant event as soon as the listener is registered
      if (event === 'close' && !spawnError) {
        Promise.resolve().then(() => cb(exitCode));
      } else if (event === 'error' && spawnError) {
        Promise.resolve().then(() => cb(spawnError));
      }
    }),
    kill: vi.fn(),
  };
  return proc;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the path hook-dispatcher will resolve for the given event's global hook dir. */
function globalHookDir(event: string): string {
  return path.join(os.homedir(), '.octomux', 'hooks', `${event}.d`);
}

function setupScriptNames(event: string, scriptNames: string[]) {
  const hookDir = globalHookDir(event);
  // Only report existing for the specific global hook dir, not for repo-local dirs
  mockExistsSync.mockImplementation((p: string) => p === hookDir);
  mockReaddirSync.mockReturnValue(
    scriptNames.map((name) => ({
      isFile: () => true,
      name,
    })),
  );
  mockAccessSync.mockReturnValue(undefined); // no error = executable
  const stream = { write: vi.fn() };
  mockCreateWriteStream.mockReturnValue(stream);
  mockMkdirSync.mockReturnValue(undefined);
}

const ENVELOPE: HookEnvelope = {
  event: 'workflow_status_changed',
  task: { id: 'task-abc', repo_path: '/tmp/repo' } as any,
  data: { from: 'in_progress', to: 'human_review' },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fireHook', () => {
  let fireHook: typeof import('./hook-dispatcher.js').fireHook;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Re-import after resetting modules so mocks take effect
    ({ fireHook } = await import('./hook-dispatcher.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when no hook dirs exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await fireHook('workflow_status_changed', ENVELOPE);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does nothing when hook dir is empty', async () => {
    const hookDir = globalHookDir('workflow_status_changed');
    mockExistsSync.mockImplementation((p: string) => p === hookDir);
    mockReaddirSync.mockReturnValue([]);
    await fireHook('workflow_status_changed', ENVELOPE);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does nothing when no scripts are executable', async () => {
    const hookDir = globalHookDir('workflow_status_changed');
    mockExistsSync.mockImplementation((p: string) => p === hookDir);
    mockReaddirSync.mockReturnValue([{ isFile: () => true, name: 'script.sh' }]);
    mockAccessSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    await fireHook('workflow_status_changed', ENVELOPE);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns script with JSON envelope on stdin and sets env vars', async () => {
    setupScriptNames('workflow_status_changed', ['notify.sh']);

    const proc = makeAutoProc({ exitCode: 0 });
    mockSpawn.mockReturnValue(proc);

    await fireHook('workflow_status_changed', ENVELOPE);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [scriptArg, , spawnOpts] = mockSpawn.mock.calls[0];
    expect(scriptArg).toContain('notify.sh');
    expect(spawnOpts.env.OCTOMUX_EVENT).toBe('workflow_status_changed');
    expect(spawnOpts.env.OCTOMUX_TASK_ID).toBe('task-abc');
    expect(proc.stdin.write).toHaveBeenCalledWith(JSON.stringify(ENVELOPE), 'utf8');
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('resolves without throwing when script exits with non-zero code', async () => {
    setupScriptNames('workflow_status_changed', ['fail.sh']);
    mockSpawn.mockReturnValue(makeAutoProc({ exitCode: 1 }));

    await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
  });

  it('resolves without throwing when spawn emits an error', async () => {
    setupScriptNames('workflow_status_changed', ['bad.sh']);
    mockSpawn.mockReturnValue(makeAutoProc({ spawnError: new Error('ENOENT') }));

    await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
  });

  it('runs scripts in alphabetical order', async () => {
    setupScriptNames('workflow_status_changed', ['z-last.sh', 'a-first.sh', 'm-middle.sh']);
    mockSpawn.mockImplementation(() => makeAutoProc({ exitCode: 0 }));

    await fireHook('workflow_status_changed', ENVELOPE);

    const spawnedNames = mockSpawn.mock.calls.map((c: any[]) => path.basename(c[0] as string));
    expect(spawnedNames).toEqual(['a-first.sh', 'm-middle.sh', 'z-last.sh']);
  });

  it('does not throw when an unexpected error occurs inside fireHook', async () => {
    // Simulate fs.existsSync throwing something unexpected
    mockExistsSync.mockImplementation(() => {
      throw new Error('filesystem exploded');
    });
    await expect(fireHook('note_added', ENVELOPE)).resolves.toBeUndefined();
  });

  it('prunes old log files beyond retention limit after script runs', async () => {
    const hookDir = globalHookDir('workflow_status_changed');
    // existsSync: only return true for the global hook dir (not repo-local) to avoid
    // running the script twice (once global, once repo-local) which would give 10 deletes.
    mockExistsSync.mockImplementation((p: string) => p === hookDir);

    // readdirSync: first call is the hook scripts dir (returns Dirent-like objects),
    //              subsequent calls are the logs dir (returns filename strings).
    const existingLogFiles = Array.from(
      { length: 55 },
      (_, i) => `workflow_status_changed-${1000 + i}-notify.sh.log`,
    );
    mockReaddirSync.mockImplementation((dir: string) => {
      if (typeof dir === 'string' && dir.endsWith('.d')) {
        return [{ isFile: () => true, name: 'notify.sh' }];
      }
      // logs dir listing
      return existingLogFiles;
    });
    mockAccessSync.mockReturnValue(undefined);
    const stream = { write: vi.fn() };
    mockCreateWriteStream.mockReturnValue(stream);
    mockMkdirSync.mockReturnValue(undefined);
    mockStatSync.mockImplementation((_p: string) => ({ mtimeMs: 1000 }));
    mockSpawn.mockReturnValue(makeAutoProc({ exitCode: 0 }));

    await fireHook('workflow_status_changed', ENVELOPE);

    // unlinkSync should have been called 5 times (55 - 50 = 5 oldest files pruned)
    expect(mockUnlinkSync).toHaveBeenCalledTimes(5);
  });
});

describe('getTaskHookExecutions', () => {
  let getTaskHookExecutions: typeof import('./hook-dispatcher.js').getTaskHookExecutions;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ getTaskHookExecutions } = await import('./hook-dispatcher.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeLogContent = (opts: {
    event: string;
    script: string;
    taskId: string;
    startedAt: number;
    durationMs?: number;
    exitCode?: number;
    body?: string;
  }) => {
    const {
      event,
      script,
      taskId,
      startedAt,
      durationMs = 123,
      exitCode = 0,
      body = 'output',
    } = opts;
    return [
      `[octomux] event=${event} script=${script} task_id=${taskId} started_at=${startedAt}`,
      body,
      `[octomux] duration_ms=${durationMs} exit_code=${exitCode}`,
    ].join('\n');
  };

  it('returns empty array when logs dir does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const results = getTaskHookExecutions('task-abc');
    expect(results).toEqual([]);
  });

  it('returns executions for matching task_id from filename', async () => {
    mockExistsSync.mockReturnValue(true);
    const fileName = 'workflow_status_changed-1700000000000-notify.sh-task-abc.log';
    mockReaddirSync.mockReturnValue([fileName]);
    mockReadFileSync.mockReturnValue(
      makeLogContent({
        event: 'workflow_status_changed',
        script: 'notify.sh',
        taskId: 'task-abc',
        startedAt: 1700000000000,
        durationMs: 250,
        exitCode: 0,
        body: 'hook ran ok',
      }),
    );

    const results = getTaskHookExecutions('task-abc');
    expect(results).toHaveLength(1);
    expect(results[0].event).toBe('workflow_status_changed');
    expect(results[0].script).toBe('notify.sh');
    expect(results[0].exit_code).toBe(0);
    expect(results[0].duration_ms).toBe(250);
    expect(results[0].stdout_excerpt).toContain('hook ran ok');
  });

  it('excludes executions for a different task_id', async () => {
    mockExistsSync.mockReturnValue(true);
    const fileName = 'workflow_status_changed-1700000000000-notify.sh-task-xyz.log';
    mockReaddirSync.mockReturnValue([fileName]);
    mockReadFileSync.mockReturnValue(
      makeLogContent({
        event: 'workflow_status_changed',
        script: 'notify.sh',
        taskId: 'task-xyz',
        startedAt: 1700000000000,
      }),
    );

    const results = getTaskHookExecutions('task-abc');
    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    mockExistsSync.mockReturnValue(true);
    const files = Array.from(
      { length: 10 },
      (_, i) => `workflow_status_changed-${i}-notify.sh-task-abc.log`,
    );
    mockReaddirSync.mockReturnValue(files);
    mockReadFileSync.mockImplementation((_p: string) =>
      makeLogContent({
        event: 'workflow_status_changed',
        script: 'notify.sh',
        taskId: 'task-abc',
        startedAt: 1700000000000,
      }),
    );

    const results = getTaskHookExecutions('task-abc', 3);
    expect(results).toHaveLength(3);
  });
});
