// octomux-plugin-ssh-compute — runs a task's git worktree and processes on
// another machine over SSH. Reference implementation of `ctx.compute.register`
// — see docs/plugins/api-reference.md §ctx.compute and this directory's
// README.md for config/secrets, remote-box prerequisites, and what's verified
// by server/compute/ssh-example.test.ts versus what still needs a real host.
//
// Zero new dependencies: the `ssh` binary plus what `ComputeCreateContext`
// already hands us (`host.exec`, `host.spawnPty`, `execBackedFiles`). We use
// `ctx.host` rather than `node:child_process` directly (even though a plugin
// runs in-process with full Node/Bun privileges and could) because the host
// owns process spawning — that's what keeps every process this provider
// starts observable and disposable by the same machinery as everything else
// octomux runs, instead of a second untracked spawn path.

/**
 * The shape `ComputeCreateContext` takes in `server/compute/types.ts`. Not
 * importable here — `@octomux/plugin-api` is types-only and doesn't export
 * it, and this package has no host import path — so it's restated as a
 * local JSDoc typedef purely for editor hints; the host is the source of
 * truth.
 * @typedef {Object} ComputeCreateContext
 * @property {Record<string, unknown>} config
 * @property {Record<string, string>} secrets
 * @property {{debug: (o: object, m?: string) => void, info: (o: object, m?: string) => void, warn: (o: object, m?: string) => void, error: (o: object, m?: string) => void}} logger
 * @property {{ exec: (argv: string[], opts?: object) => Promise<{stdout: string, stderr: string, exitCode: number}>, spawnPty: (opts: object) => Promise<object> }} host
 * @property {(exec: Function) => object} execBackedFiles
 */

/**
 * Single-quote a string for safe interpolation into a POSIX shell command:
 * wrap in `'...'`, and turn each embedded `'` into `'\''` (close the quote,
 * emit an escaped quote, reopen the quote). This is the entire injection
 * boundary of this provider — every piece of a command that crosses into the
 * *remote* shell goes through this first.
 * @param {unknown} s
 * @returns {string}
 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** @param {string[]} argv @returns {string} */
function quoteArgv(argv) {
  return argv.map(shQuote).join(' ');
}

/**
 * The local argv for the `ssh` binary itself: `ssh [-i <identityFile>]
 * [...sshOpts] [...extraFlags] <host>`. Safe to hand straight to
 * `host.exec` (no local shell involved — execFile passes argv straight to
 * the child) or to `quoteArgv`-join into one string for `host.spawnPty`
 * (which does run its `command` through a local shell).
 * @param {{ host: string; sshOpts: string[] }} conn
 * @param {Record<string, string>} secrets
 * @param {string[]} [extraFlags]
 * @returns {string[]}
 */
function sshTransportArgv(conn, secrets, extraFlags = []) {
  const argv = ['ssh'];
  // The ONLY place `identityFile` is allowed to appear. It must never be
  // folded into a remote command string, an env var, or anything written
  // into the worktree — see the "credential invariant" test in
  // server/compute/ssh-example.test.ts.
  if (secrets.identityFile) argv.push('-i', secrets.identityFile);
  argv.push(...extraFlags, ...conn.sshOpts, conn.host);
  return argv;
}

/**
 * Reads and validates `settings.compute.<qualified-kind>` (handed to us as
 * `ComputeCreateContext.config`).
 * @param {Record<string, unknown>} config
 * @returns {{ host: string; root: string; sshOpts: string[] }}
 */
function readConnection(config) {
  const host = config.host;
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error(
      'ssh-compute: config.host is required, e.g. "user@example.com" — set it under ' +
        "settings.compute.<qualified-kind> (see this plugin's README).",
    );
  }
  const root =
    typeof config.root === 'string' && config.root.length > 0 ? config.root : '~/octomux';
  const sshOpts = Array.isArray(config.sshOpts) ? config.sshOpts.map(String) : [];
  return { host, root, sshOpts };
}

/**
 * Builds the single remote command string for `exec`: an optional `VAR='..'`
 * env prefix, an optional `cd <cwd> &&`, then the shell-quoted argv. This
 * whole string becomes ONE argv element handed to `ssh` — ssh would
 * otherwise concatenate multiple trailing args with spaces and re-parse them
 * through the remote shell itself, so building one pre-quoted string up
 * front is what keeps quoting under our control instead of ssh's.
 * @param {string[]} argv
 * @param {{ cwd?: string; env?: Record<string, string> }} [opts]
 * @returns {string}
 */
function buildRemoteCommand(argv, opts = {}) {
  let cmd = quoteArgv(argv);
  if (opts.env) {
    const prefix = Object.entries(opts.env)
      .map(([k, v]) => `${k}=${shQuote(v)}`)
      .join(' ');
    if (prefix) cmd = `${prefix} ${cmd}`;
  }
  if (opts.cwd) {
    cmd = `cd ${shQuote(opts.cwd)} && ${cmd}`;
  }
  return cmd;
}

/**
 * Derives a filesystem-safe repo directory name from a git origin URL — the
 * last path segment, minus a trailing `.git`. Handles both
 * `git@host:org/repo.git` (scp-like) and `https://host/org/repo.git` shapes,
 * since both use `/` as the final separator before the repo name.
 * @param {string} originUrl
 * @returns {string}
 */
function repoNameFromOrigin(originUrl) {
  const trimmed = originUrl.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? trimmed;
  return last.replace(/\.git$/, '');
}

/**
 * `exec` for a session bound to one connection. Builds `ssh [transport
 * argv] <quoted remote command>` and runs it via `ctx.host.exec` — the
 * SERVER's local ssh client, proxying to the remote box.
 * @param {ComputeCreateContext} computeCtx
 * @param {{ host: string; root: string; sshOpts: string[] }} conn
 */
function makeExec(computeCtx, conn) {
  /**
   * @param {string[]} argv
   * @param {{cwd?: string; env?: Record<string,string>; input?: string; timeoutMs?: number; allowFailure?: boolean}} [opts]
   */
  return async function exec(argv, opts = {}) {
    if (argv.length === 0) throw new Error('ssh-compute exec: argv must not be empty');
    const remoteCommand = buildRemoteCommand(argv, opts);
    const sshArgv = sshTransportArgv(conn, computeCtx.secrets);
    return computeCtx.host.exec([...sshArgv, remoteCommand], {
      input: opts.input,
      timeoutMs: opts.timeoutMs,
      allowFailure: opts.allowFailure,
    });
  };
}

/**
 * tmux runs ON THE REMOTE BOX, with its own binary and its own default
 * socket. Deliberately not replicating the private `-S <socket>` local
 * octomux uses for its own tmux invocations: that flag exists to keep
 * octomux's sessions from colliding with the user's own tmux on their
 * laptop, which isn't a concern on a dedicated remote box — every tmux
 * session there is octomux's.
 * @param {(argv: string[], opts?: { cwd?: string }) => Promise<{stdout: string; stderr: string; exitCode: number}>} exec
 */
function makeTmux(exec) {
  return async function tmux(args, opts) {
    const { stdout, stderr } = await exec(
      ['tmux', ...args],
      opts?.cwd ? { cwd: opts.cwd } : undefined,
    );
    return { stdout, stderr };
  };
}

/**
 * `spawn` for xterm.js streaming: wraps the interactive command in
 * `ssh -t <transport> <cd+env+command>` and hands that off to
 * `ctx.host.spawnPty`, which runs it as a LOCAL pty (`ssh` is the local
 * process; `-t` forces a remote tty on the other end, without which
 * `tmux attach` refuses to run non-interactively).
 * @param {ComputeCreateContext} computeCtx
 * @param {{ host: string; root: string; sshOpts: string[] }} conn
 */
function makeSpawn(computeCtx, conn) {
  return async function spawn(opts) {
    let remoteCommand = opts.command;
    if (opts.env) {
      const prefix = Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shQuote(v)}`)
        .join(' ');
      if (prefix) remoteCommand = `${prefix} ${remoteCommand}`;
    }
    if (opts.cwd) {
      remoteCommand = `cd ${shQuote(opts.cwd)} && ${remoteCommand}`;
    }
    const sshArgv = sshTransportArgv(conn, computeCtx.secrets, ['-t']);
    // Unlike `exec` (argv straight to `host.exec`, no local shell), spawnPty
    // runs its `command` string through the LOCAL shell (`$SHELL -c
    // <command>`) — so every local argv element, including the whole
    // pre-quoted remote command, has to be quoted again here.
    const localCommand = quoteArgv([...sshArgv, remoteCommand]);
    return computeCtx.host.spawnPty({
      command: localCommand,
      // Irrelevant to the remote side (the remote `cd` above handles that) —
      // this is only where the local `ssh` process itself starts.
      cwd: process.cwd(),
      env: undefined,
      cols: opts.cols,
      rows: opts.rows,
    });
  };
}

/**
 * Confirms the server's own checkout of `task.repo_path` has an `origin`
 * remote, and derives the deterministic remote clone path from it. Shared
 * by `create` and `resume` so both land on the same `repoPath` for a given
 * task without either of them needing to persist anything.
 * @param {{ repo_path: string }} task
 * @param {(argv: string[], opts?: object) => Promise<{stdout: string; stderr: string; exitCode: number}>} exec
 * @param {{ root: string }} conn
 */
async function resolveRepoPath(task, exec, conn) {
  const origin = await exec(['git', '-C', task.repo_path, 'remote', 'get-url', 'origin'], {
    allowFailure: true,
  });
  const originUrl = origin.stdout.trim();
  if (origin.exitCode !== 0 || !originUrl) {
    throw new Error(
      `ssh-compute: repo at "${task.repo_path}" has no "origin" remote — a local-only ` +
        'repo cannot be run over ssh (there is nothing for the remote box to clone). ' +
        'Add one (`git remote add origin <url>`) or run this task on local compute instead.',
    );
  }
  const name = repoNameFromOrigin(originUrl);
  if (!name) {
    throw new Error(
      `ssh-compute: could not derive a repo directory name from origin URL "${originUrl}"`,
    );
  }
  return { originUrl, repoPath: `${conn.root}/repos/${name}` };
}

/**
 * @param {{ id: string }} task
 * @param {ComputeCreateContext} computeCtx
 * @param {{ host: string; root: string; sshOpts: string[] }} conn
 * @param {ReturnType<typeof makeExec>} exec
 * @param {string} repoPath
 */
function buildSession(task, computeCtx, conn, exec, repoPath) {
  return {
    kind: 'ssh',
    taskId: task.id,
    repoPath,
    exec,
    tmux: makeTmux(exec),
    spawn: makeSpawn(computeCtx, conn),
    files: computeCtx.execBackedFiles(exec),
    async dispose(opts) {
      // The remote box outlives the task and this provider does not own it
      // — without `destroy` there is nothing to release. With `destroy`,
      // remove only this task's worktree, never the shared clone at
      // `repoPath` and never the box itself.
      if (!opts?.destroy) return;
      const worktreePath = `${repoPath}/.worktrees/${task.id}`;
      await exec(['rm', '-rf', worktreePath]);
    },
  };
}

/**
 * `create(task, ctx)` — first run for this task. Makes sure the repo exists
 * on the remote (clone if absent, fetch if present) before returning.
 * @param {{ id: string; repo_path: string }} task
 * @param {ComputeCreateContext} computeCtx
 */
export async function create(task, computeCtx) {
  const conn = readConnection(computeCtx.config);
  const exec = makeExec(computeCtx, conn);
  const { originUrl, repoPath } = await resolveRepoPath(task, exec, conn);

  await exec(['mkdir', '-p', `${conn.root}/repos`]);
  const cloneExists = await exec(['test', '-d', `${repoPath}/.git`], { allowFailure: true });
  if (cloneExists.exitCode === 0) {
    computeCtx.logger.info({ taskId: task.id, repoPath }, 'ssh-compute: fetching existing clone');
    await exec(['git', '-C', repoPath, 'fetch', '--all', '--quiet']);
  } else {
    computeCtx.logger.info({ taskId: task.id, repoPath, originUrl }, 'ssh-compute: cloning repo');
    await exec(['git', 'clone', originUrl, repoPath]);
  }

  return buildSession(task, computeCtx, conn, exec, repoPath);
}

/**
 * `resume(task, ctx)` — re-attach after a server restart. The remote box is
 * persistent, so this is `create()` MINUS the clone/fetch: it derives the
 * same `repoPath` and confirms the clone is still there, but never touches
 * the network to update it. `create()` runs once, at task start, and is
 * allowed to be slow (cloning) or to mutate remote state (fetching);
 * `resume()` runs on every server restart across every ssh-backed task and
 * must not turn a boot into N remote fetches.
 * @param {{ id: string; repo_path: string }} task
 * @param {ComputeCreateContext} computeCtx
 */
export async function resume(task, computeCtx) {
  const conn = readConnection(computeCtx.config);
  const exec = makeExec(computeCtx, conn);
  const { repoPath } = await resolveRepoPath(task, exec, conn);

  const cloneExists = await exec(['test', '-d', `${repoPath}/.git`], { allowFailure: true });
  if (cloneExists.exitCode !== 0) {
    throw new Error(
      `ssh-compute: resume() found no clone at "${repoPath}" on "${conn.host}" — it may ` +
        'have been removed on the remote box. Delete and recreate the task.',
    );
  }

  return buildSession(task, computeCtx, conn, exec, repoPath);
}

/** @param {import('@octomux/plugin-api').PluginContext} ctx */
export async function apply(ctx) {
  ctx.compute.register({ kind: 'ssh', create, resume });
  ctx.logger.info({ pluginId: ctx.id }, 'octomux-plugin-ssh-compute: apply() done');
}
