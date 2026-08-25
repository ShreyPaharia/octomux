/**
 * The compute provider seam: decides WHERE a task's git worktree lives and
 * where its processes run. Today every caller in `server/task-engine/*`
 * talks to `execTmux`, `execFile('git', ...)`, node `fs`, and `pty.spawn`
 * directly against the local machine — this seam gives that a name and a
 * boundary, nothing more.
 *
 * A git worktree per run is octomux's guarantee, not a preference. This is
 * NOT a pluggable isolation strategy — every provider still gets a real git
 * worktree; a provider only changes which machine that worktree (and the
 * processes touching it) lives on.
 */

import type { ProcessHandle, SpawnOptions } from '../agent-session/substrate.js';
import type { Task } from '../types.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child's stdin and closed. */
  input?: string;
  timeoutMs?: number;
  /** When true, a non-zero exit resolves instead of throwing. */
  allowFailure?: boolean;
}

export interface ComputeFiles {
  exists(p: string): Promise<boolean>;
  mkdirp(p: string, opts?: { mode?: number }): Promise<void>;
  /** null when the file does not exist. Any other failure throws. */
  read(p: string): Promise<string | null>;
  /** `mode` is ENFORCED, not just applied at creation — node's `writeFile`
   *  ignores `mode` when the file already exists, which would silently leave a
   *  secret-bearing file at whatever permissions it had. Implementations chmod
   *  after writing. */
  write(p: string, content: string, opts?: { mode?: number }): Promise<void>;
  /** Present because `write`/`mkdirp` modes alone can't express "fix the
   *  permissions on something already there" — the hook-install path needs
   *  that for config files holding a hook token. */
  chmod(p: string, mode: number): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface ComputeSession {
  /** The provider kind that made this session. */
  readonly kind: string;
  readonly taskId: string;
  /**
   * The **source repo** root on the compute — the checkout worktrees are cut
   * from, NOT the task's own worktree. For `local` this is `task.repo_path`;
   * a remote provider returns its own clone path.
   *
   * The task's worktree is `<repoPath>/.worktrees/<branch-or-slug>` and is
   * created by `server/task-engine/setup/new.ts` *after* the session exists,
   * which is why it isn't a member here — at `create()` time it doesn't exist
   * yet. Once setup has run, the authoritative value is `task.worktree` in the
   * DB. A provider that needs to clean up a task's worktree in
   * `dispose({ destroy: true })` should capture what it needs in the closure
   * `create()` returns rather than reconstructing that path convention.
   *
   * `run_mode` bends this: `none` runs directly in `repoPath` with no
   * worktree, and `scratch` uses a directory outside the repo entirely.
   */
  readonly repoPath: string;
  /** Run to completion. Throws on non-zero unless `opts.allowFailure`. */
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  /**
   * Signature must match `execTmux` in `server/tmux-bin.ts` exactly,
   * including that it throws on failure with the execFile error object
   * (call sites read `err.stderr` — see `isTmuxTargetMissing` in
   * `server/task-engine/sessions.ts`). The provider owns tmux binary +
   * socket resolution.
   */
  tmux(args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  /** Interactive pty, for xterm.js streaming. */
  spawn(opts: SpawnOptions): Promise<ProcessHandle>;
  readonly files: ComputeFiles;
  /**
   * Release server-side handles. `destroy: true` additionally tears down the
   * remote compute (a no-op for `local`).
   */
  dispose(opts?: { destroy?: boolean }): Promise<void>;
}

/**
 * The server's own machine, handed to a provider's `create`/`resume`. This is
 * deliberately the only runtime capability handed to a compute provider.
 * `@octomux/plugin-api` is types-only — nothing runtime crosses that
 * boundary — so a plugin-supplied provider has no other way to reach a
 * process. Every remote provider (ssh, docker, a cloud CLI) is fundamentally
 * "run a local command that proxies to the remote box"; this is that local
 * command surface.
 */
export interface ComputeHost {
  /** Run argv on the SERVER's own machine. */
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  /**
   * Spawn a local pty on the SERVER's own machine. A provider whose
   * transport is a command (`ssh -t host …`, `docker exec -it …`) gets
   * xterm.js streaming by wrapping its transport command in this.
   */
  spawnPty(opts: SpawnOptions): Promise<ProcessHandle>;
}

export interface ComputeCreateContext {
  /** `settings.compute[kind]`, may be `{}`. */
  config: Record<string, unknown>;
  /**
   * Resolved server-side by the host. Handed only to `create()`; it must
   * never reach the agent's environment, the launched command, or anything
   * written into the worktree.
   */
  secrets: Record<string, string>;
  logger: {
    debug(obj: object, msg?: string): void;
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  /** The server's own machine. Build your transport on this. */
  host: ComputeHost;
  /**
   * A `ComputeFiles` implemented purely over the `exec` you pass in — a
   * remote provider gets exists/mkdirp/read/write/copy/rm for free in one
   * line.
   */
  execBackedFiles(exec: ComputeSession['exec']): ComputeFiles;
}

export interface ComputeProvider {
  readonly kind: string;
  create(task: Task, ctx: ComputeCreateContext): Promise<ComputeSession>;
  /**
   * Re-attach after a server restart. When absent the host falls back to
   * `create()`.
   */
  resume?(task: Task, ctx: ComputeCreateContext): Promise<ComputeSession>;
}
