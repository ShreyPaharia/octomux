import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { findExecCall, countExecCalls } from '../test-helpers.js';
import {
  tmuxWindowSubstrate,
  getActiveWindowIndex,
  getLastWindowIndex,
} from './substrate-tmux-windowed.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    const argList = args[1] as string[];
    if (argList.includes('display-message')) {
      cb(null, { stdout: '0\n', stderr: '' });
    } else if (argList.includes('list-windows')) {
      cb(null, { stdout: '0\n1\n2\n', stderr: '' });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
    return undefined as never;
  });
});

describe('tmuxWindowSubstrate.launchWindow', () => {
  it('fresh=true emits new-session with the startup command', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=true emits set-option aggressive-resize', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['set-option', 'aggressive-resize', 'on'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=true queries active window index via display-message', async () => {
    const idx = await tmuxWindowSubstrate.launchWindow({
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['display-message'],
    });
    expect(call).toBeDefined();
    expect(typeof idx).toBe('number');
  });

  it('fresh=false emits new-window (not new-session)', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const newWindowCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-window'],
    });
    expect(newWindowCall).toBeDefined();

    const newSessionCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session'],
    });
    expect(newSessionCall).toBeUndefined();
  });

  it('fresh=false queries last window index via list-windows', async () => {
    const idx = await tmuxWindowSubstrate.launchWindow({
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['list-windows'],
    });
    expect(call).toBeDefined();
    expect(typeof idx).toBe('number');
  });

  it('fresh=true passes session and cwd to new-session', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'my-session',
      cwd: '/my/worktree',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session', '-s', 'my-session', '-c', '/my/worktree'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=false passes session and cwd to new-window', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'my-session',
      cwd: '/my/worktree',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-window', '-t', 'my-session', '-c', '/my/worktree'],
    });
    expect(call).toBeDefined();
  });

  it('omits startup command when not provided', async () => {
    await tmuxWindowSubstrate.launchWindow({
      session: 'my-session',
      cwd: '/my/worktree',
      fresh: false,
    });

    expect(countExecCalls(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['new-window'] })).toBe(
      1,
    );
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-window', '-t', 'my-session', '-c', '/my/worktree'],
    });
    expect(call).toBeDefined();
    const args = call![1] as string[];
    const subcommandIndex = args.indexOf('new-window');
    expect(args.slice(subcommandIndex)).toEqual([
      'new-window',
      '-t',
      'my-session',
      '-c',
      '/my/worktree',
    ]);
  });
});

describe('tmuxWindowSubstrate.createEmptySession', () => {
  it('creates a detached session without a startup command', async () => {
    await tmuxWindowSubstrate.createEmptySession({ session: 'octomux-agent-x', cwd: '/wt' });

    const sessionCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session', '-d', '-s', 'octomux-agent-x', '-c', '/wt'],
    });
    expect(sessionCall).toBeDefined();

    const optionCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['set-option', 'aggressive-resize', 'on'],
    });
    expect(optionCall).toBeDefined();
  });
});

describe('window index helpers', () => {
  it('getActiveWindowIndex parses display-message output', async () => {
    const idx = await getActiveWindowIndex('octomux-agent-test');
    expect(idx).toBe(0);
  });

  it('getLastWindowIndex returns max window index', async () => {
    const idx = await getLastWindowIndex('octomux-agent-test');
    expect(idx).toBe(2);
  });
});
