import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

const {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
  sendToOrchestrator,
} = await import('./orchestrator.js');
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
  it('creates tmux session and launches claude with system prompt', async () => {
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
    // Verify claude command includes --system-prompt with the prompt file
    const sendKeysArgs = calls[2][1] as string[];
    const claudeCmd = sendKeysArgs[sendKeysArgs.indexOf('-t') + 2];
    expect(claudeCmd).toContain('claude --system-prompt');
    expect(claudeCmd).toContain('orchestrator-prompt.md');
    expect(claudeCmd).toContain('"Greet me and show what you can do"');
  });

  it('bakes initial message into claude launch command', async () => {
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

    await startOrchestrator('/test/cwd', 'Create a task to fix bugs');

    const sendKeysCall = vi.mocked(execFile).mock.calls[2];
    const claudeCmd = (sendKeysCall[1] as string[])[
      (sendKeysCall[1] as string[]).indexOf('-t') + 2
    ];
    expect(claudeCmd).toContain('Greet me, then handle:');
    expect(claudeCmd).toContain('Create a task to fix bugs');
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

describe('sendToOrchestrator', () => {
  it('sends message via tmux send-keys with literal flag then Enter separately', async () => {
    await sendToOrchestrator('hello world');

    const calls = vi.mocked(execFile).mock.calls;
    // has-session check + send-keys -l (message) + send-keys (Enter)
    expect(calls).toHaveLength(3);
    // Literal message send
    expect(calls[1][0]).toBe('tmux');
    expect(calls[1][1]).toEqual(['send-keys', '-l', '-t', 'octomux-orchestrator', 'hello world']);
    // Enter key send (NOT literal)
    expect(calls[2][0]).toBe('tmux');
    expect(calls[2][1]).toEqual(['send-keys', '-t', 'octomux-orchestrator', 'Enter']);
  });

  it('throws if orchestrator is not running', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });

    await expect(sendToOrchestrator('hello')).rejects.toThrow('Orchestrator is not running');
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
