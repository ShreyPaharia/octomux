/**
 * Drives docs/plugins/examples/ssh-compute/index.mjs against a fake `host`
 * — no real `ssh`, no real network. See that plugin's README §"Verified /
 * not verified" for exactly what this proves versus what still needs a real
 * remote host.
 */
import { describe, it, expect, vi } from '../bun-test.js';

/**
 * The example plugin is plain JSDoc-typed `.mjs` (no `.d.ts`, matching every
 * other file under `docs/plugins/examples/`) — this is the module's runtime
 * shape, restated here purely so this TypeScript test file doesn't need
 * `allowJs`/`checkJs` turned on for the whole `server/` project just to
 * import it.
 */
interface SshComputeExampleModule {
  apply: (ctx: unknown) => Promise<void>;
  shQuote: (s: unknown) => string;
  create: (task: unknown, ctx: unknown) => Promise<SshSession>;
  resume: (task: unknown, ctx: unknown) => Promise<SshSession>;
}
interface SshSession {
  kind: string;
  taskId: string;
  repoPath: string;
  exec: (
    argv: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      input?: string;
      timeoutMs?: number;
      allowFailure?: boolean;
    },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  tmux: (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  spawn: (opts: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  }) => Promise<unknown>;
  files: unknown;
  dispose: (opts?: { destroy?: boolean }) => Promise<void>;
}

const { apply, shQuote, create, resume } = (await import(
  // @ts-expect-error TS7016 — plain JSDoc-typed `.mjs`, no `.d.ts` (see the
  // module comment above); the `as unknown as` cast below gives everything
  // after this line a real type.
  '../../docs/plugins/examples/ssh-compute/index.mjs'
)) as unknown as SshComputeExampleModule;

const SECRET = 'IDENTITY-FILE-CANARY-9f8e7d';

/** The provider shell-quotes every argv element (including the command
 *  name itself) into the remote command string — so `git status` shows up
 *  as `'git' 'status'`, not the bare words. Strip the quoting for the
 *  fake's own routing logic; the real tests below assert the quoted form
 *  directly against `exec.mock.calls`. */
function bare(remoteCommand: string): string {
  return remoteCommand.replace(/'/g, '');
}

/** Quotes every argv element the same way the provider's own `quoteArgv`
 *  does, so tests assert composition (order, cd/env wrapping) against the
 *  already-independently-tested `shQuote`, instead of hand-transcribing
 *  escape sequences. */
function q(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}

/** A minimal fake ComputeCreateContext. Every `host.exec`/`host.spawnPty`
 *  call is recorded on `calls` so assertions can inspect exact argv. */
function fakeCtx(
  overrides: { config?: Record<string, unknown>; secrets?: Record<string, string> } = {},
) {
  const calls: { kind: 'exec' | 'spawnPty'; argv?: string[]; opts?: unknown }[] = [];

  /** argv[0] === 'ssh' -> remote command is the last element. Everything
   *  else (git, test, mkdir, cat, ...) is a "remote-side" command already
   *  run without going through ssh in this fake, so tests can also inspect
   *  what git commands a bare `exec()` call would have produced pre-ssh-wrap
   *  by looking at the tail of the ssh argv. */
  const exec = vi.fn(async (argv: string[], opts?: { allowFailure?: boolean; input?: string }) => {
    calls.push({ kind: 'exec', argv, opts });
    const remoteCommand = bare(argv[argv.length - 1] ?? '');

    if (remoteCommand.includes('remote get-url origin')) {
      return { stdout: 'git@example.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    if (remoteCommand.includes('test -d')) {
      // Default: clone does NOT exist yet. Individual tests override via
      // ctx.host.exec mock replacement when they need the other branch.
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const spawnPty = vi.fn(async (opts: { command: string }) => {
    calls.push({ kind: 'spawnPty', opts });
    return {
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      dispose: vi.fn(),
    };
  });

  const ctx = {
    config: { host: 'deploy@remote.example', root: '/home/deploy/octomux', ...overrides.config },
    secrets: { identityFile: SECRET, ...overrides.secrets },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    host: { exec, spawnPty },
    execBackedFiles: (execFn: unknown) => ({ __execBackedFilesOver: execFn }),
  };

  return { ctx, calls, exec, spawnPty };
}

function task(overrides: Partial<{ id: string; repo_path: string }> = {}) {
  return { id: 'task-abc123', repo_path: '/Users/dev/repo', ...overrides };
}

describe('ssh-compute example plugin', () => {
  describe('shQuote', () => {
    it('wraps a plain string in single quotes', () => {
      expect(shQuote('hello')).toBe("'hello'");
    });

    it('survives a space', () => {
      expect(shQuote('has space')).toBe("'has space'");
    });

    it('neutralizes a command substitution', () => {
      const quoted = shQuote('$(rm -rf /)');
      expect(quoted).toBe("'$(rm -rf /)'");
      // Single-quoted in POSIX shell: $() is never expanded.
      expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
    });

    it('escapes an embedded single quote', () => {
      expect(shQuote("it's here")).toBe("'it'\\''s here'");
    });

    it('preserves a literal newline inside the quotes', () => {
      const quoted = shQuote('line1\nline2');
      expect(quoted).toBe("'line1\nline2'");
    });
  });

  describe('apply()', () => {
    it('registers a compute provider under kind "ssh"', async () => {
      const register = vi.fn();
      const ctx = {
        id: 'ssh',
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        compute: { register },
      };
      await apply(ctx as never);
      expect(register).toHaveBeenCalledTimes(1);
      const provider = register.mock.calls[0][0];
      expect(provider.kind).toBe('ssh');
      expect(typeof provider.create).toBe('function');
      expect(typeof provider.resume).toBe('function');
    });
  });

  describe('create()', () => {
    it('clones when the remote repo directory does not exist', async () => {
      const { ctx, calls } = fakeCtx();
      const session = await create(task(), ctx as never);

      expect(session.kind).toBe('ssh');
      expect(session.taskId).toBe('task-abc123');
      expect(session.repoPath).toBe('/home/deploy/octomux/repos/widgets');

      const cloneCall = calls.find((c) => c.argv?.some((a) => bare(a).includes('git clone')));
      expect(cloneCall).toBeDefined();
      expect(bare(cloneCall!.argv![cloneCall!.argv!.length - 1])).toContain(
        'git clone git@example.com:acme/widgets.git',
      );
      const fetchCall = calls.find((c) => c.argv?.some((a) => bare(a).includes('fetch')));
      expect(fetchCall).toBeUndefined();
    });

    it('fetches instead of cloning when the remote repo directory already exists', async () => {
      const { ctx, exec, calls } = fakeCtx();
      exec.mockImplementation(async (argv: string[]) => {
        calls.push({ kind: 'exec', argv });
        const remoteCommand = bare(argv[argv.length - 1] ?? '');
        if (remoteCommand.includes('remote get-url origin')) {
          return { stdout: 'git@example.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
        }
        if (remoteCommand.includes('test -d')) {
          return { stdout: '', stderr: '', exitCode: 0 }; // clone already exists
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const session = await create(task(), ctx as never);
      expect(session.repoPath).toBe('/home/deploy/octomux/repos/widgets');

      const cloneCall = calls.find((c) => c.argv?.some((a) => bare(a).includes('git clone')));
      expect(cloneCall).toBeUndefined();
      const fetchCall = calls.find((c) => c.argv?.some((a) => bare(a).includes('fetch')));
      expect(fetchCall).toBeDefined();
    });

    it('throws a clear error when the repo has no origin remote', async () => {
      const { ctx, exec } = fakeCtx();
      exec.mockImplementation(async (argv: string[]) => {
        const remoteCommand = bare(argv[argv.length - 1] ?? '');
        if (remoteCommand.includes('remote get-url origin')) {
          return { stdout: '', stderr: 'error: No such remote', exitCode: 2 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(create(task(), ctx as never)).rejects.toThrow(/no "origin" remote/i);
    });
  });

  describe('resume()', () => {
    it('returns a session without cloning or fetching when the clone already exists', async () => {
      const { ctx, exec, calls } = fakeCtx();
      exec.mockImplementation(async (argv: string[]) => {
        calls.push({ kind: 'exec', argv });
        const remoteCommand = bare(argv[argv.length - 1] ?? '');
        if (remoteCommand.includes('remote get-url origin')) {
          return { stdout: 'git@example.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
        }
        if (remoteCommand.includes('test -d')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const session = await resume(task(), ctx as never);
      expect(session.repoPath).toBe('/home/deploy/octomux/repos/widgets');
      expect(calls.some((c) => c.argv?.some((a) => bare(a).includes('git clone')))).toBe(false);
      expect(calls.some((c) => c.argv?.some((a) => bare(a).includes('fetch')))).toBe(false);
    });

    it('throws when the clone is missing on the remote', async () => {
      const { ctx, exec } = fakeCtx();
      exec.mockImplementation(async (argv: string[]) => {
        const remoteCommand = bare(argv[argv.length - 1] ?? '');
        if (remoteCommand.includes('remote get-url origin')) {
          return { stdout: 'git@example.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
        }
        if (remoteCommand.includes('test -d')) {
          return { stdout: '', stderr: '', exitCode: 1 }; // missing
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(resume(task(), ctx as never)).rejects.toThrow(/no clone at/i);
    });
  });

  describe('session.exec()', () => {
    it('builds ssh transport argv and a correctly quoted remote command', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.exec(['echo', 'hi there']);

      expect(exec).toHaveBeenCalledTimes(1);
      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[0]).toBe('ssh');
      expect(argv).toContain('-i');
      expect(argv[argv.indexOf('-i') + 1]).toBe(SECRET);
      expect(argv).toContain('deploy@remote.example');
      // The remote command is the last argv element: every word shell-quoted.
      expect(argv[argv.length - 1]).toBe(q(['echo', 'hi there']));
    });

    it('applies and quotes opts.cwd as a remote cd prefix', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.exec(['ls'], { cwd: '/a path/with space' });

      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[argv.length - 1]).toBe(`cd ${shQuote('/a path/with space')} && ${q(['ls'])}`);
    });

    it('applies and quotes opts.env as remote VAR=val prefixes', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.exec(['printenv', 'FOO'], { env: { FOO: "bar's value" } });

      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[argv.length - 1]).toBe(`FOO=${shQuote("bar's value")} ${q(['printenv', 'FOO'])}`);
    });

    it('applies cwd and env together, cwd wrapping the env-prefixed command', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.exec(['ls'], { cwd: '/work', env: { FOO: 'bar' } });

      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[argv.length - 1]).toBe(
        `cd ${shQuote('/work')} && FOO=${shQuote('bar')} ${q(['ls'])}`,
      );
    });

    it('respects config.sshOpts in the transport argv', async () => {
      const { ctx, exec } = fakeCtx({ config: { sshOpts: ['-p', '2222'] } });
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.exec(['true']);

      const argv = exec.mock.calls[0][0] as string[];
      expect(argv).toEqual([
        'ssh',
        '-i',
        SECRET,
        '-p',
        '2222',
        'deploy@remote.example',
        q(['true']),
      ]);
    });
  });

  describe('session.tmux()', () => {
    it('reaches the remote as a tmux command through exec', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.tmux(['list-sessions']);

      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[argv.length - 1]).toBe(q(['tmux', 'list-sessions']));
    });
  });

  describe('session.spawn()', () => {
    it('wraps the command in a -t ssh invocation as one quoted local string', async () => {
      const { ctx, spawnPty } = fakeCtx();
      const session = await create(task(), ctx as never);

      await session.spawn({
        command: 'tmux attach -t mysession',
        cwd: '/home/deploy/octomux',
        cols: 80,
        rows: 24,
      });

      expect(spawnPty).toHaveBeenCalledTimes(1);
      const opts = spawnPty.mock.calls[0][0] as { command: string; cols: number; rows: number };
      expect(opts.cols).toBe(80);
      expect(opts.rows).toBe(24);

      // spawn's remote command is NOT word-quoted (opts.command is already a
      // full shell command line, not argv) — only cwd gets wrapped. The
      // whole thing then becomes one element of the LOCAL ssh argv, which
      // (unlike exec's host.exec) runs through a local shell and so gets
      // fully quoted itself.
      const remoteCommand = `cd ${shQuote('/home/deploy/octomux')} && tmux attach -t mysession`;
      expect(opts.command).toBe(
        q(['ssh', '-i', SECRET, '-t', 'deploy@remote.example', remoteCommand]),
      );
    });
  });

  describe('credential invariant', () => {
    it('the identityFile secret appears only in ssh transport argv, never in a remote command', async () => {
      const { ctx, calls } = fakeCtx();
      const session = await create(task(), ctx as never);
      calls.length = 0;

      await session.exec(['git', 'status'], { cwd: '/work', env: { TOKEN: 'not-the-secret' } });
      await session.tmux(['list-sessions']);
      await session.spawn({ command: 'tmux attach -t mysession', cwd: '/work' });

      for (const call of calls) {
        const argv = call.argv ?? [];
        const opts = call.opts as { command?: string } | undefined;
        const command = opts?.command;

        if (call.kind === 'exec') {
          // The secret is allowed at argv[i] right after '-i' (the ssh flag)
          // and nowhere else in this argv.
          const iIndex = argv.indexOf('-i');
          expect(iIndex).toBeGreaterThan(-1);
          expect(argv[iIndex + 1]).toBe(SECRET);
          const withoutIdentityFlag = argv.filter((_, idx) => idx !== iIndex && idx !== iIndex + 1);
          expect(withoutIdentityFlag.some((a) => a.includes(SECRET))).toBe(false);
          // Specifically: never in the remote command string (the last element).
          expect(argv[argv.length - 1].includes(SECRET)).toBe(false);
        }

        if (call.kind === 'spawnPty' && command) {
          // Secret appears exactly once, as the `-i <secret>` pair, never
          // duplicated into the remote (post -t <host>) portion of the string.
          const occurrences = command.split(SECRET).length - 1;
          expect(occurrences).toBe(1);
          expect(command).toContain(`${shQuote('-i')} ${shQuote(SECRET)}`);
        }
      }
    });
  });

  describe('session.dispose()', () => {
    it('removes the task worktree when destroy is true', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.dispose({ destroy: true });

      expect(exec).toHaveBeenCalledTimes(1);
      const argv = exec.mock.calls[0][0] as string[];
      expect(argv[argv.length - 1]).toBe(
        q(['rm', '-rf', '/home/deploy/octomux/repos/widgets/.worktrees/task-abc123']),
      );
    });

    it('does nothing without destroy', async () => {
      const { ctx, exec } = fakeCtx();
      const session = await create(task(), ctx as never);
      exec.mockClear();

      await session.dispose();
      await session.dispose({ destroy: false });

      expect(exec).not.toHaveBeenCalled();
    });
  });
});
