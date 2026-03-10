import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

const { isOrchestratorRunning, startOrchestrator, stopOrchestrator, getOrchestratorSession } =
  await import('./orchestrator.js');
const { execFile } = await import('child_process');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: has-session succeeds (session exists)
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined as any;
  });
});

describe('getOrchestratorSession', () => {
  it('returns the session name', () => {
    expect(getOrchestratorSession()).toBe('octomux-orchestrator');
  });
});

describe('isOrchestratorRunning', () => {
  it('returns true when tmux session exists', async () => {
    expect(await isOrchestratorRunning()).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['has-session', '-t', 'octomux-orchestrator'],
      expect.any(Function),
    );
  });

  it('returns false when tmux session does not exist', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });
    expect(await isOrchestratorRunning()).toBe(false);
  });
});

describe('startOrchestrator', () => {
  it('creates tmux session and launches claude', async () => {
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      callCount++;
      const cb = args.find((a: any) => typeof a === 'function');
      if (callCount === 1) {
        if (cb) cb(new Error('no session'));
      } else {
        if (cb) cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await startOrchestrator('/test/cwd');

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toContain('new-session');
    expect(calls[2][1]).toContain('send-keys');
  });

  it('does not create session if already running', async () => {
    await startOrchestrator();

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('has-session');
  });

  it('uses cwd when provided', async () => {
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      callCount++;
      const cb = args.find((a: any) => typeof a === 'function');
      if (callCount === 1) {
        if (cb) cb(new Error('no session'));
      } else {
        if (cb) cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await startOrchestrator('/my/project');

    const newSessionCall = vi.mocked(execFile).mock.calls[1];
    expect(newSessionCall[1]).toContain('/my/project');
  });
});

describe('stopOrchestrator', () => {
  it('kills the tmux session', async () => {
    await stopOrchestrator();

    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'octomux-orchestrator'],
      expect.any(Function),
    );
  });

  it('does not throw when session does not exist', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });

    await expect(stopOrchestrator()).resolves.not.toThrow();
  });
});
