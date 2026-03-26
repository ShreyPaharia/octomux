import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('fs', () => {
  const promises = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  };
  return { default: { promises } };
});

vi.mock('os');

const {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
  sendToOrchestrator,
  getCustomPrompt,
  getDefaultPrompt,
  getOrchestratorPrompt,
  saveCustomPrompt,
  resetCustomPrompt,
} = await import('./orchestrator.js');
const { execFile } = await import('child_process');
const fs = await import('fs');
const os = await import('os');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: has-session succeeds (session exists)
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === 'function');
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined as any;
  });
  vi.mocked(os.default.homedir).mockReturnValue('/mock-home');
  vi.mocked(os.default.tmpdir).mockReturnValue('/mock-tmp');
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

describe('getCustomPrompt', () => {
  it('returns file content when custom prompt exists', async () => {
    vi.mocked(fs.default.promises.readFile).mockResolvedValue('custom prompt content');
    const result = await getCustomPrompt();
    expect(result).toBe('custom prompt content');
    expect(fs.default.promises.readFile).toHaveBeenCalledWith(
      '/mock-home/.octomux/orchestrator-prompt.md',
      'utf-8',
    );
  });

  it('returns null when file does not exist', async () => {
    const err = new Error('ENOENT') as any;
    err.code = 'ENOENT';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(err);
    const result = await getCustomPrompt();
    expect(result).toBeNull();
  });

  it('throws on non-ENOENT errors', async () => {
    const err = new Error('EACCES') as any;
    err.code = 'EACCES';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(err);
    await expect(getCustomPrompt()).rejects.toThrow('EACCES');
  });
});

describe('getDefaultPrompt', () => {
  it('reads the agent definition file', async () => {
    vi.mocked(fs.default.promises.readFile).mockResolvedValue('default prompt');
    const result = await getDefaultPrompt();
    expect(result).toBe('default prompt');
    const calledPath = vi.mocked(fs.default.promises.readFile).mock.calls[0][0] as string;
    expect(calledPath).toContain('.claude/agents/orchestrator.md');
    expect(calledPath).not.toContain('.octomux');
  });
});

describe('getOrchestratorPrompt', () => {
  it('returns custom prompt when it exists', async () => {
    vi.mocked(fs.default.promises.readFile).mockResolvedValue('custom prompt');
    const result = await getOrchestratorPrompt();
    expect(result).toBe('custom prompt');
  });

  it('falls back to default when custom does not exist', async () => {
    let callCount = 0;
    vi.mocked(fs.default.promises.readFile).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('ENOENT') as any;
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve('default prompt');
    });
    const result = await getOrchestratorPrompt();
    expect(result).toBe('default prompt');
  });
});

describe('saveCustomPrompt', () => {
  it('creates directory and writes file', async () => {
    vi.mocked(fs.default.promises.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.default.promises.writeFile).mockResolvedValue(undefined);
    await saveCustomPrompt('new prompt');
    expect(fs.default.promises.mkdir).toHaveBeenCalledWith('/mock-home/.octomux', {
      recursive: true,
    });
    expect(fs.default.promises.writeFile).toHaveBeenCalledWith(
      '/mock-home/.octomux/orchestrator-prompt.md',
      'new prompt',
      'utf-8',
    );
  });
});

describe('resetCustomPrompt', () => {
  it('deletes the custom prompt file', async () => {
    vi.mocked(fs.default.promises.unlink).mockResolvedValue(undefined);
    await resetCustomPrompt();
    expect(fs.default.promises.unlink).toHaveBeenCalledWith(
      '/mock-home/.octomux/orchestrator-prompt.md',
    );
  });

  it('ignores ENOENT when file does not exist', async () => {
    const err = new Error('ENOENT') as any;
    err.code = 'ENOENT';
    vi.mocked(fs.default.promises.unlink).mockRejectedValue(err);
    await expect(resetCustomPrompt()).resolves.not.toThrow();
  });

  it('throws on non-ENOENT errors', async () => {
    const err = new Error('EACCES') as any;
    err.code = 'EACCES';
    vi.mocked(fs.default.promises.unlink).mockRejectedValue(err);
    await expect(resetCustomPrompt()).rejects.toThrow('EACCES');
  });
});

describe('startOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(fs.default.promises.writeFile).mockResolvedValue(undefined);
  });

  function mockSessionNotRunning() {
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
  }

  function getClaudeCmd(): string {
    const sendKeysCall = vi.mocked(execFile).mock.calls[2];
    const sendKeysArgs = sendKeysCall[1] as string[];
    return sendKeysArgs[sendKeysArgs.indexOf('-t') + 2];
  }

  it('uses --agent orchestrator when no custom prompt exists', async () => {
    mockSessionNotRunning();
    // No custom prompt — readFile for custom path throws ENOENT
    const enoent = new Error('ENOENT') as any;
    enoent.code = 'ENOENT';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(enoent);

    await startOrchestrator('/test/cwd');

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toContain('new-session');
    expect(calls[2][1]).toContain('send-keys');
    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toBe('claude --agent orchestrator');
    expect(claudeCmd).not.toContain('--system-prompt');
  });

  it('falls back to --system-prompt when custom prompt exists', async () => {
    mockSessionNotRunning();
    vi.mocked(fs.default.promises.readFile).mockResolvedValue('custom prompt content');

    await startOrchestrator('/test/cwd');

    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toContain('claude --system-prompt');
    expect(claudeCmd).toContain('octomux-orchestrator-prompt.md');
  });

  it('bakes initial message into claude launch command', async () => {
    mockSessionNotRunning();
    const enoent = new Error('ENOENT') as any;
    enoent.code = 'ENOENT';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(enoent);

    await startOrchestrator('/test/cwd', 'Create a task to fix bugs');

    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toContain('Create a task to fix bugs');
  });

  it('escapes shell metacharacters in initial message with single quotes', async () => {
    mockSessionNotRunning();
    const enoent = new Error('ENOENT') as any;
    enoent.code = 'ENOENT';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(enoent);

    await startOrchestrator('/test/cwd', 'Fix the $HOME bug; rm -rf / && echo `whoami`');

    const claudeCmd = getClaudeCmd();
    // Message should be wrapped in single quotes to prevent shell interpretation
    expect(claudeCmd).toContain("'Fix the $HOME bug");
    // Dangerous chars should be inside single quotes (not interpreted)
    expect(claudeCmd).toContain('$HOME');
    expect(claudeCmd).toContain('`whoami`');
  });

  it('does not create session if already running', async () => {
    await startOrchestrator();

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain('has-session');
  });

  it('uses cwd when provided', async () => {
    mockSessionNotRunning();
    const enoent = new Error('ENOENT') as any;
    enoent.code = 'ENOENT';
    vi.mocked(fs.default.promises.readFile).mockRejectedValue(enoent);

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
