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

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    accessSync: mockAccessSync,
    mkdirSync: mockMkdirSync,
    createWriteStream: mockCreateWriteStream,
    constants: { X_OK: 1 },
  },
}));

// ─── Fake Process ─────────────────────────────────────────────────────────────

/**
 * Creates a fake child_process that fires close/error automatically when
 * the test registers a listener for that event (synchronously on next
 * microtask tick, safely after the caller sets up all listeners).
 */
function makeAutoProc({ exitCode = 0, spawnError }: { exitCode?: number; spawnError?: Error } = {}) {
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
});
