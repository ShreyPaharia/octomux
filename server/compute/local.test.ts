import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { IDLE_TASK_FIXTURE } from '@octomux/test-fixtures';
import type { Task } from '../types.js';
import type { ComputeCreateContext } from './types.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    plugins: {},
  })),
}));

const { execFile } = await import('child_process');
const mockedExecFile = vi.mocked(execFile);

const {
  localCompute,
  localExec,
  localFiles,
  localSession,
  sessionFor,
  releaseSession,
  _resetSessions,
  execBackedFiles,
  registerCompute,
  unregisterCompute,
} = await import('./index.js');

/** A fake ChildProcess-shaped stand-in — only `.stdin.end` is exercised. */
function fakeChild(stdinEnd: (...args: unknown[]) => unknown = vi.fn()) {
  return { stdin: { end: stdinEnd } };
}

function task(overrides: Partial<Task> = {}): Task {
  return { ...IDLE_TASK_FIXTURE, ...overrides };
}

/** Minimal ComputeCreateContext for exercising create() directly (outside
 *  of sessionFor's own resolveComputeContext, which is covered separately). */
function fakeCtx(): ComputeCreateContext {
  return {
    config: {},
    secrets: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    host: {
      exec: localExec,
      spawnPty: async () => {
        throw new Error('not exercised in these tests');
      },
    },
    execBackedFiles,
  };
}

describe('localExec', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it('passes argv, cwd, and merged env through to execFile', async () => {
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, { stdout: 'out', stderr: '' });
      return fakeChild();
    }) as unknown as typeof execFile);

    const result = await localExec(['git', 'status'], {
      cwd: '/repo',
      env: { FOO: 'bar' },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ stdout: 'out', stderr: '', exitCode: 0 });
    const [cmd, args, options] = mockedExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['status']);
    expect((options as any).cwd).toBe('/repo');
    expect((options as any).timeout).toBe(5000);
    // env is merged OVER process.env, not a replacement.
    expect((options as any).env).toMatchObject({ ...process.env, FOO: 'bar' });
  });

  it('throws the raw execFile error (carrying stdout/stderr/code) on non-zero exit', async () => {
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      // promisify rejects with the error object alone — extra callback args
      // are discarded — so stdout/stderr must live ON the error itself.
      const err = Object.assign(new Error('exit 3'), {
        code: 3,
        stdout: 'partial-out',
        stderr: 'partial-err',
      });
      cb(err);
      return fakeChild();
    }) as unknown as typeof execFile);

    await expect(localExec(['false'])).rejects.toMatchObject({
      code: 3,
      stdout: 'partial-out',
      stderr: 'partial-err',
    });
  });

  it('resolves instead of throwing when allowFailure is set', async () => {
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      const err = Object.assign(new Error('exit 3'), {
        code: 3,
        stdout: 'partial-out',
        stderr: 'partial-err',
      });
      cb(err);
      return fakeChild();
    }) as unknown as typeof execFile);

    const result = await localExec(['false'], { allowFailure: true });
    expect(result).toEqual({ stdout: 'partial-out', stderr: 'partial-err', exitCode: 3 });
  });

  it('writes opts.input to the child stdin', async () => {
    const stdinEnd = vi.fn();
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, '', '');
      return fakeChild(stdinEnd);
    }) as unknown as typeof execFile);

    await localExec(['cat'], { input: 'hello stdin' });
    expect(stdinEnd).toHaveBeenCalledWith('hello stdin');
  });

  it('throws a clear error on empty argv', () => {
    expect(() => localExec([])).toThrow(/argv must not be empty/);
  });
});

describe('localCompute session', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it('create() returns a session bound to the task id and repo_path', async () => {
    const t = task({ id: 'task-x', repo_path: '/repo/x' });
    const session = await localCompute.create(t, fakeCtx());
    expect(session.kind).toBe('local');
    expect(session.taskId).toBe('task-x');
    expect(session.repoPath).toBe('/repo/x');
  });

  it('tmux() delegates straight to execTmux with untouched args', async () => {
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, { stdout: 'tmux-out', stderr: '' });
      return fakeChild();
    }) as unknown as typeof execFile);

    const session = await localCompute.create(task({ id: 'task-y' }), fakeCtx());
    await session.tmux(['list-sessions', '-F', '#{session_name}']);

    const [cmd, args] = mockedExecFile.mock.calls[0];
    expect(cmd).toBe('tmux');
    // execTmux prepends '-S <sock>' to every invocation; strip it for the
    // "untouched args" assertion.
    const stripped = (args as string[])[0] === '-S' ? (args as string[]).slice(2) : args;
    expect(stripped).toEqual(['list-sessions', '-F', '#{session_name}']);
  });

  it('dispose() is a no-op that resolves', async () => {
    const session = await localCompute.create(task(), fakeCtx());
    await expect(session.dispose()).resolves.toBeUndefined();
    await expect(session.dispose({ destroy: true })).resolves.toBeUndefined();
  });
});

describe('localSession', () => {
  it('is task-free and shares localFiles', () => {
    expect(localSession.kind).toBe('local');
    expect(localSession.taskId).toBe('');
    expect(localSession.repoPath).toBe('');
    expect(localSession.files).toBe(localFiles);
  });
});

describe('localFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'octomux-compute-test-'));
  });

  afterEach(() => {
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips exists/mkdirp/write/read/copy/rm', async () => {
    const p = path.join(dir, 'sub', 'file.txt');

    expect(await localFiles.exists(p)).toBe(false);
    expect(await localFiles.read(p)).toBeNull();

    await localFiles.mkdirp(path.dirname(p));
    await localFiles.write(p, 'hello', { mode: 0o600 });

    expect(await localFiles.exists(p)).toBe(true);
    expect(await localFiles.read(p)).toBe('hello');
    expect(fsSync.statSync(p).mode & 0o777).toBe(0o600);

    const dst = path.join(dir, 'copy.txt');
    await localFiles.copy(p, dst);
    expect(await localFiles.read(dst)).toBe('hello');

    await localFiles.rm(dst);
    expect(await localFiles.exists(dst)).toBe(false);
  });

  it('read of a missing file returns null', async () => {
    expect(await localFiles.read(path.join(dir, 'nope.txt'))).toBeNull();
  });

  it('chmod sets the mode on an existing file', async () => {
    const f = path.join(dir, 'perm.txt');
    await localFiles.write(f, 'x');
    await localFiles.chmod(f, 0o600);
    expect(fsSync.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('write ENFORCES mode on an existing file, not just at creation', async () => {
    // node's writeFile honours `mode` only when it creates the file — without
    // the chmod a rewritten secret-bearing file keeps its old permissions.
    const f = path.join(dir, 'enforced.txt');
    await localFiles.write(f, 'first', { mode: 0o644 });
    await localFiles.write(f, 'second', { mode: 0o600 });
    expect(fsSync.statSync(f).mode & 0o777).toBe(0o600);
    expect(await localFiles.read(f)).toBe('second');
  });

  it('mkdirp applies mode to a directory that already exists', async () => {
    const d = path.join(dir, 'dir700');
    await localFiles.mkdirp(d);
    await localFiles.mkdirp(d, { mode: 0o700 });
    expect(fsSync.statSync(d).mode & 0o777).toBe(0o700);
  });
});

describe('sessionFor / releaseSession', () => {
  beforeEach(() => {
    _resetSessions();
    mockedExecFile.mockReset();
  });

  it('caches the session by task id', async () => {
    const t = task({ id: 'sf-a', repo_path: '/repo/a' });
    const s1 = await sessionFor(t);
    const s2 = await sessionFor(t);
    expect(s1).toBe(s2);
    expect(s1.taskId).toBe('sf-a');
    expect(s1.repoPath).toBe('/repo/a');
  });

  it('concurrent calls for the same task id share one in-flight promise', async () => {
    const t = task({ id: 'sf-b', repo_path: '/repo/b' });
    const [s1, s2] = await Promise.all([sessionFor(t), sessionFor(t)]);
    expect(s1).toBe(s2);
  });

  it('different task ids get different sessions', async () => {
    const s1 = await sessionFor(task({ id: 'sf-c1' }));
    const s2 = await sessionFor(task({ id: 'sf-c2' }));
    expect(s1).not.toBe(s2);
  });

  it('releaseSession drops the cache entry and disposes the session', async () => {
    const t = task({ id: 'sf-d' });
    const s1 = await sessionFor(t);
    const disposeSpy = vi.spyOn(s1, 'dispose');

    await releaseSession('sf-d', { destroy: true });
    expect(disposeSpy).toHaveBeenCalledWith({ destroy: true });

    const s2 = await sessionFor(t);
    expect(s2).not.toBe(s1);
  });

  it('releaseSession on an uncached task id is a no-op', async () => {
    await expect(releaseSession('never-cached')).resolves.toBeUndefined();
  });
});

describe('resolveComputeContext (observed via a captured create() ctx)', () => {
  afterEach(() => {
    unregisterCompute('test-capture');
    _resetSessions();
  });

  it('hands the provider a ctx.host bound to the local machine and a working execBackedFiles', async () => {
    let captured: ComputeCreateContext | undefined;
    registerCompute({
      kind: 'test-capture',
      create: async (_t, ctx) => {
        captured = ctx;
        return localSession;
      },
    });

    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, { stdout: 'host-out', stderr: '' });
      return fakeChild();
    }) as unknown as typeof execFile);

    // `compute` isn't a real Task column yet (later wave) — same cast
    // sessionFor itself uses to read it.
    const t = { ...task({ id: 'sf-host' }), compute: 'test-capture' } as unknown as Task;
    await sessionFor(t);

    expect(captured).toBeDefined();

    // ctx.host.exec runs on THIS (the server's) machine.
    const hostResult = await captured!.host.exec(['echo', 'hi']);
    expect(hostResult.stdout).toBe('host-out');
    expect(mockedExecFile.mock.calls[0][0]).toBe('echo');

    // ctx.execBackedFiles(exec) produces a working ComputeFiles.
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, { stdout: '', stderr: '' });
      return fakeChild();
    }) as unknown as typeof execFile);
    const files = captured!.execBackedFiles(captured!.host.exec);
    await files.mkdirp('/tmp/octomux-compute-ctx-test');
    const lastCall = mockedExecFile.mock.calls.at(-1)!;
    expect(lastCall.slice(0, 2)).toEqual(['mkdir', ['-p', '/tmp/octomux-compute-ctx-test']]);
  });
});
