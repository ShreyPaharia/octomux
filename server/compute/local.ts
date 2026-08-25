import { execFile as execFileCb, type ExecFileException } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { execTmux } from '../tmux-bin.js';
import { ptySubstrate } from '../agent-session/substrate-pty.js';
import { registerCompute } from './registry.js';
import type {
  ComputeFiles,
  ComputeProvider,
  ComputeSession,
  ExecOpts,
  ExecResult,
} from './types.js';

const execFileProm = promisify(execFileCb);

/** Real node `fs` — this is the whole point: local compute is byte-identical
 *  to what octomux does today. */
export const localFiles: ComputeFiles = {
  async exists(p) {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  },

  async mkdirp(p, opts) {
    await fs.promises.mkdir(p, {
      recursive: true,
      ...(opts?.mode !== undefined && { mode: opts.mode }),
    });
    // `mkdir` applies `mode` only to directories it actually creates, and umask
    // masks it even then. chmod so an existing dir is corrected too.
    if (opts?.mode !== undefined) await fs.promises.chmod(p, opts.mode);
  },

  async read(p) {
    try {
      return await fs.promises.readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },

  async write(p, content, opts) {
    await fs.promises.writeFile(p, content, opts?.mode !== undefined ? { mode: opts.mode } : {});
    // writeFile honours `mode` only when it creates the file. Enforce it.
    if (opts?.mode !== undefined) await fs.promises.chmod(p, opts.mode);
  },

  async chmod(p, mode) {
    await fs.promises.chmod(p, mode);
  },

  async copy(src, dst) {
    await fs.promises.cp(src, dst, { recursive: true });
  },

  async rm(p, opts) {
    await fs.promises.rm(p, { recursive: opts?.recursive ?? false, force: true });
  },
};

/**
 * Run `argv[0]` with `argv.slice(1)` to completion on this machine.
 *
 * Two paths, deliberately:
 *
 * - **No `opts.input`** (everything core does) → `promisify(execFile)`, which
 *   is exactly what every call site used before the compute seam existed.
 *   Keeping it means the suite's `child_process` mocks — which call back
 *   promisify-style as `cb(err, { stdout, stderr })` — keep resolving the way
 *   they always have. Switching the whole file to the raw 3-arg callback would
 *   have been "more correct" against real Node while silently breaking every
 *   still-`promisify`-based consumer sharing the same mock, since a mocked
 *   `vi.fn()` loses execFile's `promisify.custom` and falls back to generic
 *   promisify (resolve with the callback's 2nd argument only).
 * - **With `opts.input`** → the raw callback form, because writing to the
 *   child's stdin needs the live `ChildProcess` that promisify never hands
 *   back. Only `execBackedFiles` (i.e. remote providers) takes this path.
 *
 * Both paths reject with the raw execFile error carrying `.stdout`/`.stderr`,
 * or resolve with the exit code when `opts.allowFailure` is set.
 */
export function localExec(argv: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  if (argv.length === 0) {
    throw new Error('exec: argv must not be empty');
  }
  const [cmd, ...args] = argv;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const spawnOpts = { cwd: opts.cwd, env, timeout: opts.timeoutMs };

  const onFailure = (
    err: ExecFileException,
    stdout: string,
    stderr: string,
  ): ExecResult | never => {
    const execErr = err as ExecFileException & { stdout?: string; stderr?: string };
    execErr.stdout ??= stdout;
    execErr.stderr ??= stderr;
    if (opts.allowFailure) {
      return { stdout, stderr, exitCode: typeof err.code === 'number' ? err.code : 1 };
    }
    throw execErr;
  };

  if (opts.input === undefined) {
    return execFileProm(cmd, args, spawnOpts).then(
      ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }),
      (err: ExecFileException & { stdout?: string; stderr?: string }) =>
        onFailure(err, String(err.stdout ?? ''), String(err.stderr ?? '')),
    );
  }

  return new Promise((resolve, reject) => {
    const child = execFileCb(cmd, args, spawnOpts, (err, stdout, stderr) => {
      if (err) {
        try {
          resolve(onFailure(err, stdout, stderr));
        } catch (thrown) {
          reject(thrown);
        }
        return;
      }
      resolve({ stdout, stderr, exitCode: 0 });
    });
    // Close stdin (after writing `input`) so a command that reads stdin to EOF
    // doesn't hang forever waiting for input that never comes.
    child.stdin?.end(opts.input);
  });
}

/** One `ComputeSession` implementation shared by every local session,
 *  task-bound or not — `taskId`/`repoPath` are the only things that differ. */
function makeLocalSession(taskId: string, repoPath: string): ComputeSession {
  return {
    kind: 'local',
    taskId,
    repoPath,
    exec: localExec,
    tmux: execTmux,
    spawn: (opts) => ptySubstrate.spawn(opts),
    files: localFiles,
    async dispose() {
      // Local compute owns nothing to release — the task engine already
      // owns tmux/worktree teardown.
    },
  };
}

/** The server's own machine, not bound to any task. Call sites that
 *  legitimately operate on the server's local checkout (diff reads, comment
 *  hashing, repo probes) pass this explicitly, so "which machine does this
 *  run on" stays a visible decision at every call site rather than an
 *  implicit default. */
export const localSession: ComputeSession = makeLocalSession('', '');

export const localCompute: ComputeProvider = {
  kind: 'local',

  async create(task) {
    return makeLocalSession(task.id, task.repo_path);
  },
};

registerCompute(localCompute);
