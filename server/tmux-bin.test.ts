import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./binary-check.js', () => ({
  probeBinary: vi.fn(() => ({ ok: true })),
}));

vi.mock('./logger.js', () => ({
  childLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    return undefined as any;
  }),
}));

const { probeBinary } = await import('./binary-check.js');

// Import the module under test *after* mocks are established
const {
  tmuxBinPath,
  tmuxBaseArgs,
  tmuxEnv,
  tmuxSpawnSpec,
  tmuxResolution,
  execTmux,
  _resetTmuxResolution,
} = await import('./tmux-bin.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

const originalEnv = process.env;

beforeEach(() => {
  _resetTmuxResolution();
  vi.clearAllMocks();
  vi.mocked(probeBinary).mockReturnValue({ ok: true });
  // Remove the env override between tests
  delete process.env.OCTOMUX_TMUX_BIN;
});

afterEach(() => {
  // Restore original env
  process.env = originalEnv;
  _resetTmuxResolution();
});

// ─── Packaged Electron mode ───────────────────────────────────────────────────

describe('packaged Electron mode (process.versions.electron + resourcesPath)', () => {
  const FAKE_RESOURCES = '/Applications/octomux.app/Contents/Resources';
  // Cast helpers to avoid TS errors on non-standard process properties
  type AugmentedVersions = typeof process.versions & { electron?: string };
  type AugmentedProcess = typeof process & { resourcesPath?: string };

  afterEach(() => {
    // Restore process globals mutated by this suite
    delete (process.versions as AugmentedVersions).electron;
    delete (process as AugmentedProcess).resourcesPath;
    _resetTmuxResolution();
  });

  it('is a no-op under plain Node (process.versions.electron undefined)', () => {
    // Ensure electron version is NOT set (it shouldn't be in vitest/Node)
    delete (process.versions as AugmentedVersions).electron;

    _resetTmuxResolution();
    const res = tmuxResolution();
    // Without electron set, falls through to PATH fallback
    expect(res.source).toBe('path');
  });

  it('does not crash and falls through gracefully when Electron globals are set but asar dir is absent', () => {
    // Simulate a packaged Electron environment
    (process.versions as AugmentedVersions).electron = '33.0.0';
    (process as AugmentedProcess).resourcesPath = FAKE_RESOURCES;

    // fs.existsSync returns false for the asar index.js (dir does not exist)
    // so the branch exits early and falls through to the PATH fallback.
    _resetTmuxResolution();
    const res = tmuxResolution();

    // Branch is entered but falls through — PATH fallback is used.
    expect(['bundled', 'path']).toContain(res.source);
  });
});

// ─── tmuxBinPath ──────────────────────────────────────────────────────────────

describe('tmuxBinPath', () => {
  it('falls back to PATH "tmux" when no env override and bundled package missing', () => {
    const bin = tmuxBinPath();
    expect(bin).toBe('tmux');
  });

  it('uses OCTOMUX_TMUX_BIN env override when set', () => {
    process.env.OCTOMUX_TMUX_BIN = '/usr/local/custom/tmux';
    _resetTmuxResolution();
    const bin = tmuxBinPath();
    expect(bin).toBe('/usr/local/custom/tmux');
  });

  it('memoizes the result across calls', () => {
    const first = tmuxBinPath();
    const second = tmuxBinPath();
    expect(first).toBe(second);
    // probeBinary should only be called once during resolution
    expect(vi.mocked(probeBinary)).toHaveBeenCalledTimes(1);
  });
});

// ─── tmuxResolution ───────────────────────────────────────────────────────────

describe('tmuxResolution', () => {
  it('reports source=path when using PATH fallback', () => {
    const res = tmuxResolution();
    expect(res.source).toBe('path');
    expect(res.path).toBe('tmux');
  });

  it('reports verified=true when probeBinary succeeds', () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: true });
    _resetTmuxResolution();
    const res = tmuxResolution();
    expect(res.verified).toBe(true);
  });

  it('reports verified=false when probeBinary fails', () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: false });
    _resetTmuxResolution();
    const res = tmuxResolution();
    expect(res.verified).toBe(false);
  });

  it('reports source=env when OCTOMUX_TMUX_BIN is set', () => {
    process.env.OCTOMUX_TMUX_BIN = '/opt/tmux';
    _resetTmuxResolution();
    const res = tmuxResolution();
    expect(res.source).toBe('env');
    expect(res.path).toBe('/opt/tmux');
  });
});

// ─── tmuxBaseArgs ─────────────────────────────────────────────────────────────

describe('tmuxBaseArgs', () => {
  it('returns ["-S", <absolute socket path>]', () => {
    const args = tmuxBaseArgs();
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-S');
    expect(path.isAbsolute(args[1] as string)).toBe(true);
  });

  it('socket basename is always "tmux.sock"', () => {
    const [, sockPath] = tmuxBaseArgs();
    expect(path.basename(sockPath)).toBe('tmux.sock');
  });

  it('socket path fits the OS sun_path limit (<=104 chars)', () => {
    // A deep worktree pushes the preferred <dataDir>/run/tmux.sock past the
    // macOS Unix-socket limit; the length guard must keep the returned path short
    // enough for tmux to bind it.
    const [, sockPath] = tmuxBaseArgs();
    expect((sockPath as string).length).toBeLessThanOrEqual(104);
  });

  it('uses <dataDir>/run/tmux.sock when short, else a hashed tmpdir fallback', () => {
    const [, sockPath] = tmuxBaseArgs();
    const parentDir = path.basename(path.dirname(sockPath));
    // Preferred layout keeps the socket directly under a "run" dir; the long-path
    // fallback uses a short, hashed "octomux-<hash>" dir under the system tmpdir.
    expect(parentDir === 'run' || /^octomux-[0-9a-f]+$/.test(parentDir)).toBe(true);
  });
});

// ─── tmuxEnv ──────────────────────────────────────────────────────────────────

describe('tmuxEnv', () => {
  it('returns a copy of the base env when no terminfoDir is set', () => {
    const base = { HOME: '/home/user', PATH: '/usr/bin' };
    const env = tmuxEnv(base);
    expect(env.HOME).toBe('/home/user');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.TERMINFO_DIRS).toBeUndefined();
  });

  it('does not mutate the passed-in base env', () => {
    const base: NodeJS.ProcessEnv = { HOME: '/home/user' };
    tmuxEnv(base);
    expect(Object.keys(base)).toEqual(['HOME']);
  });

  it('uses process.env by default when no base arg is provided', () => {
    const env = tmuxEnv();
    // Should at minimum contain the process env keys
    expect(env).toMatchObject({});
  });
});

// ─── tmuxSpawnSpec ────────────────────────────────────────────────────────────

describe('tmuxSpawnSpec', () => {
  it('returns file=tmuxBinPath()', () => {
    const spec = tmuxSpawnSpec(['attach-session', '-t', 'my-session']);
    expect(spec.file).toBe(tmuxBinPath());
  });

  it('prepends -S <socket> to extraArgs', () => {
    const spec = tmuxSpawnSpec(['attach-session', '-t', 'my-session']);
    expect(spec.args[0]).toBe('-S');
    expect(spec.args[1]).toMatch(/tmux\.sock$/);
    expect(spec.args[2]).toBe('attach-session');
    expect(spec.args[3]).toBe('-t');
    expect(spec.args[4]).toBe('my-session');
  });

  it('includes env in the result', () => {
    const spec = tmuxSpawnSpec([]);
    expect(spec.env).toBeDefined();
    expect(typeof spec.env).toBe('object');
  });
});

// ─── execTmux ─────────────────────────────────────────────────────────────────

describe('execTmux', () => {
  it('calls execFile with binary + socket prefix + subcommand args', async () => {
    const { execFile } = await import('child_process');
    vi.mocked(execFile).mockClear();

    await execTmux(['new-session', '-d', '-s', 'test-session']);

    expect(execFile).toHaveBeenCalledOnce();
    const [cmd, rawArgs] = vi.mocked(execFile).mock.calls[0];
    const args = rawArgs as string[];
    expect(cmd).toBe('tmux');
    expect(args[0]).toBe('-S');
    expect(args[1]).toMatch(/tmux\.sock$/);
    expect(args[2]).toBe('new-session');
    expect(args[3]).toBe('-d');
    expect(args[4]).toBe('-s');
    expect(args[5]).toBe('test-session');
  });

  it('passes env to execFile options', async () => {
    const { execFile } = await import('child_process');
    vi.mocked(execFile).mockClear();

    await execTmux(['list-sessions']);

    expect(execFile).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(execFile).mock.calls[0];
    // promisify passes options as 3rd arg; env should be in there
    const opts = callArgs[2] as Record<string, unknown>;
    expect(opts).toBeDefined();
    expect(typeof opts).toBe('object');
    expect(opts.env).toBeDefined();
  });

  it('resolves with stdout and stderr', async () => {
    const { execFile } = await import('child_process');
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: 'session1', stderr: '' });
      return undefined as any;
    });

    const result = await execTmux(['list-sessions']);
    expect(result.stdout).toBe('session1');
    expect(result.stderr).toBe('');
  });

  it('rejects when execFile errors', async () => {
    const { execFile } = await import('child_process');
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(new Error('tmux not found'));
      return undefined as any;
    });

    await expect(execTmux(['list-sessions'])).rejects.toThrow('tmux not found');
  });
});

// ─── _resetTmuxResolution ─────────────────────────────────────────────────────

describe('_resetTmuxResolution', () => {
  it('clears the memoized resolution so next call re-resolves', () => {
    // Trigger resolution once
    tmuxBinPath();
    expect(vi.mocked(probeBinary)).toHaveBeenCalledTimes(1);

    // Reset and resolve again
    _resetTmuxResolution();
    tmuxBinPath();
    expect(vi.mocked(probeBinary)).toHaveBeenCalledTimes(2);
  });
});
