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

vi.mock('./agents.js', () => ({
  getAgent: vi.fn(),
  saveAgent: vi.fn(),
  resetAgent: vi.fn(),
  syncAgents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ editor: 'nvim', useOrchestratorAgent: false }),
}));

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
const settings = await import('./settings.js');
const os = await import('os');
const agents = await import('./agents.js');

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
  it('returns content when agent is custom', async () => {
    vi.mocked(agents.getAgent).mockResolvedValue({
      name: 'orchestrator',
      content: 'custom prompt content',
      defaultContent: 'default content',
      isCustom: true,
    });
    const result = await getCustomPrompt();
    expect(result).toBe('custom prompt content');
    expect(agents.getAgent).toHaveBeenCalledWith('orchestrator');
  });

  it('returns null when agent is not custom', async () => {
    vi.mocked(agents.getAgent).mockResolvedValue({
      name: 'orchestrator',
      content: 'default content',
      defaultContent: 'default content',
      isCustom: false,
    });
    const result = await getCustomPrompt();
    expect(result).toBeNull();
  });

  it('throws when getAgent throws', async () => {
    vi.mocked(agents.getAgent).mockRejectedValue(new Error('EACCES'));
    await expect(getCustomPrompt()).rejects.toThrow('EACCES');
  });
});

describe('getDefaultPrompt', () => {
  it('returns the defaultContent from the agent', async () => {
    vi.mocked(agents.getAgent).mockResolvedValue({
      name: 'orchestrator',
      content: 'custom content',
      defaultContent: 'default prompt',
      isCustom: true,
    });
    const result = await getDefaultPrompt();
    expect(result).toBe('default prompt');
    expect(agents.getAgent).toHaveBeenCalledWith('orchestrator');
  });
});

describe('getOrchestratorPrompt', () => {
  it('returns content (custom or default) from the agent', async () => {
    vi.mocked(agents.getAgent).mockResolvedValue({
      name: 'orchestrator',
      content: 'custom prompt',
      defaultContent: 'default prompt',
      isCustom: true,
    });
    const result = await getOrchestratorPrompt();
    expect(result).toBe('custom prompt');
  });

  it('returns default content when agent is not custom', async () => {
    vi.mocked(agents.getAgent).mockResolvedValue({
      name: 'orchestrator',
      content: 'default prompt',
      defaultContent: 'default prompt',
      isCustom: false,
    });
    const result = await getOrchestratorPrompt();
    expect(result).toBe('default prompt');
  });
});

describe('saveCustomPrompt', () => {
  it('delegates to saveAgent with orchestrator name', async () => {
    vi.mocked(agents.saveAgent).mockResolvedValue(undefined);
    await saveCustomPrompt('new prompt');
    expect(agents.saveAgent).toHaveBeenCalledWith('orchestrator', 'new prompt');
  });
});

describe('resetCustomPrompt', () => {
  it('delegates to resetAgent with orchestrator name', async () => {
    vi.mocked(agents.resetAgent).mockResolvedValue(undefined);
    await resetCustomPrompt();
    expect(agents.resetAgent).toHaveBeenCalledWith('orchestrator');
  });

  it('propagates errors from resetAgent', async () => {
    const err = new Error('EACCES') as any;
    err.code = 'EACCES';
    vi.mocked(agents.resetAgent).mockRejectedValue(err);
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

  it('uses plain claude when useOrchestratorAgent is disabled', async () => {
    mockSessionNotRunning();

    await startOrchestrator('/test/cwd');

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toContain('new-session');
    expect(calls[2][1]).toContain('send-keys');
    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toBe('claude');
  });

  it('uses --agent orchestrator when useOrchestratorAgent is enabled', async () => {
    mockSessionNotRunning();
    vi.mocked(settings.getSettings).mockResolvedValue({
      editor: 'nvim',
      useOrchestratorAgent: true,
    });

    await startOrchestrator('/test/cwd');

    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toBe('claude --agent orchestrator');
  });

  it('bakes initial message into claude launch command', async () => {
    mockSessionNotRunning();

    await startOrchestrator('/test/cwd', 'Create a task to fix bugs');

    const claudeCmd = getClaudeCmd();
    expect(claudeCmd).toContain('Create a task to fix bugs');
  });

  it('escapes shell metacharacters in initial message with single quotes', async () => {
    mockSessionNotRunning();

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
