# octomux-plugin-ssh-compute

A real, non-toy `ctx.compute` provider: it runs a task's git worktree and
every process octomux launches for that task (the agent, tmux, `git`) on
**another machine, over SSH**, instead of the server's own machine.

It exists to prove the compute seam (`server/compute/`) is a real boundary —
something outside `server/compute/` registers a provider through
`ctx.compute.register()` and it works — and to be the reference every future
provider (EC2, Daytona, a container) gets copied from. It also doubles as the
honest first answer to "can a plugin's untrusted work be sandboxed?" — see
**Trust model** below.

## What it does

- `create(task, ctx)` — first run for a task. Confirms the server's own
  checkout of `task.repo_path` has an `origin` remote, then on the remote box:
  clones into `<root>/repos/<name>` if that clone doesn't exist yet, or
  `git fetch`es it if it does.
- `resume(task, ctx)` — re-attach after an octomux server restart. The remote
  box is persistent, so this is `create()` **minus the clone/fetch**: same
  deterministic `repoPath`, but no network call to update it (a restart with
  many ssh-backed tasks would otherwise mean a burst of remote fetches for no
  reason — `create()` is allowed to be slow and to mutate remote state,
  `resume()` is not).
- `exec(argv, opts)` — runs `argv` on the remote box via `ssh`, with
  `opts.cwd`/`opts.env` translated into a `cd ... && VAR=... ...` prefix on
  the remote command string.
- `tmux(args)` — `exec(['tmux', ...args])`. tmux runs **on the remote box**,
  with its own binary and its own default socket (see the code comment in
  `makeTmux` for why the private `-S <socket>` local octomux uses isn't
  replicated here).
- `spawn(opts)` — the same transport, but through `ssh -t` and
  `ctx.host.spawnPty` instead of `ctx.host.exec`, so xterm.js can stream an
  interactive session (`tmux attach`) against the remote box.
- `files` — `ctx.execBackedFiles(exec)`. One line; every file op becomes a
  remote `test`/`mkdir`/`cat`/`chmod`/`cp`/`rm` over the same `exec`.
- `dispose({ destroy })` — without `destroy`, a no-op (the box outlives the
  task). With `destroy`, `rm -rf`s **only this task's worktree**
  (`<repoPath>/.worktrees/<taskId>`) — never the shared clone, never the box.
  This provider does not own the machine and never tears it down.

Zero new dependencies. The transport is the `ssh` binary plus what
`ComputeCreateContext` already hands a provider — `ctx.host.exec`,
`ctx.host.spawnPty`, `ctx.execBackedFiles`. Every remote command goes through
`ctx.host` (the server's own machine) rather than `node:child_process`
directly — a plugin _could_ shell out itself (plugins run in-process with
full Node/Bun privileges), but that would be a second, untracked spawn path;
`ctx.host` is what keeps every process this provider starts observable and
disposable by the same machinery as everything else octomux runs.

## Install

```bash
npm install octomux-plugin-ssh-compute
```

(Not published — for local testing, point the manifest row's `name` at this
directory's **absolute path** instead, same as `hello-plugin`; see
[`../hello-plugin/README.md`](../hello-plugin/README.md) for why a directory
import works under Bun's ESM resolver.)

## Manifest row

```yaml
# ~/.octomux/octomux.yml
plugins:
  - id: ssh
    name: /absolute/path/to/docs/plugins/examples/ssh-compute
```

This plugin registers `ctx.compute.register({ kind: 'ssh', ... })` — a
**local** id. octomux qualifies it under the manifest row's own `id` before
it reaches the real provider registry
(`qualify()`, `server/plugins/qualify.ts`), so with the row above the
provider is actually registered as **`ssh:ssh`**. That colon is not a typo —
every plugin-registered kind is `<row-id>:<local-kind>`, which is also what
structurally prevents a plugin from squatting a core (colon-free) kind name
like `local`. Use the qualified form everywhere below.

## Configure it

Settings live under `settings.compute.<qualified-kind>` — i.e.
`settings.compute["ssh:ssh"]` for the manifest row above. A `secrets` sub-key
holds anything that must go through `${env:VAR}` expansion and land in
`ctx.secrets` instead of `ctx.config` (`computeConfigFor()`,
`server/settings.ts` — the same `${env:VAR_NAME}` convention integration
providers already use):

```json
// PATCH /api/settings body
{
  "compute": {
    "ssh:ssh": {
      "host": "deploy@build-box.internal",
      "root": "~/octomux",
      "sshOpts": ["-o", "StrictHostKeyChecking=accept-new"],
      "secrets": {
        "identityFile": "${env:OCTOMUX_SSH_COMPUTE_KEY}"
      }
    }
  }
}
```

```bash
export OCTOMUX_SSH_COMPUTE_KEY=/Users/you/.ssh/octomux_remote_ed25519
```

| Field (`ctx.config`) | Required                 | Meaning                                                                           |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `host`               | yes                      | `user@hostname` for the `ssh` argv                                                |
| `root`               | no (default `~/octomux`) | remote directory this provider works under — clones live at `<root>/repos/<name>` |
| `sshOpts`            | no                       | extra argv appended to every `ssh` invocation (e.g. `-p 2222`, host-key options)  |

| Field (`ctx.secrets`) | Required | Meaning                                                                                                                                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identityFile`        | no       | path to a private key, passed as `ssh -i <identityFile>`. Omit it to rely on `ssh-agent` or the default identity — this provider never requires a key-file specifically, only _some_ working key-based (non-interactive) login |

Run a task on it:

```bash
octomux create-task --repo /path/to/repo --compute ssh:ssh --prompt "..."
```

## Prerequisites on the remote box

- `git`, `tmux`, and the agent harness's own CLI (e.g. `claude`) on `PATH` for
  the SSH user's non-interactive login shell.
- Key-based SSH login for that user (no interactive password/2FA prompt) —
  `create`/`resume`/`exec` all run non-interactively.
- The user needs write access to `root` (default `~/octomux`) and network
  access to whatever `origin` the task's repo resolves to (the remote box
  clones from the URL your **server's own checkout** reports, so it must be
  reachable from the remote box, not just from your laptop — e.g. an SSH
  remote URL needs the remote box's own key forwarded or a deploy key, an
  HTTPS URL needs the remote box's own credential helper).

## Trust model

Restated from the root `docs/plugins/README.md` §Limits, because it matters
more here than almost anywhere else in the plugin surface: **there is no
sandbox.** This plugin's `create`/`resume`/`exec`/`spawn` run in-process on
the octomux server, with the DB handle, every other credential, and
`process.env` all reachable from the same process — same as any other
plugin. What a _compute provider_ adds is that the **remote box** becomes a
real isolation boundary for the task's own work: the agent's file writes,
`git` operations, and arbitrary shell commands run over there, not on the
server. That is a meaningfully stronger boundary than any in-process
capability grant — but it is a boundary around the _task_, not around this
plugin's own code, which the server trusts exactly as much as every other
manifest row.

### Credential invariant

`ctx.secrets.identityFile` is used to build the **transport argv only** — the
literal `-i <path>` passed to the local `ssh` binary. It is never folded into
a remote command string, a remote env var, or anything `files.write()` puts
in the worktree. `server/compute/ssh-example.test.ts` asserts this directly:
it registers the provider with a recognizable secret value, drives
`create()` + several `exec()`s, and checks the secret string appears **only**
in the argv passed to `ctx.host.exec`/`ctx.host.spawnPty` for the `ssh`
invocation itself — nowhere in the remote command string, `opts.env`, or
`opts.cwd`.

## Verified / not verified

**Verified by `server/compute/ssh-example.test.ts`** (fake `ctx`, fake
`host.exec`/`host.spawnPty` recording argv — no real SSH, no real network):

- `shQuote` against nasty inputs: a space, `$(...)`, an embedded `'`, a
  newline.
- `exec(argv, opts)` builds the expected `ssh [-i identity] [sshOpts] <host>
<quoted remote command>` argv, with `cwd` → `cd <quoted> &&` and `env` →
  `VAR='val' ...`, both correctly quoted.
- `tmux(args)` reaches the remote as `tmux ...` through the same `exec`.
- `spawn(opts)` builds a `-t`-flagged ssh invocation as a single, fully
  quoted local command string for `host.spawnPty`.
- The `identityFile` secret appears only in the `ssh` transport argv, never
  in anything that would run on the remote box.
- `create()` clones when the remote clone directory doesn't exist yet, and
  fetches instead when it does.
- `create()` throws a clear, actionable error when the repo has no `origin`
  remote.
- `dispose({ destroy: true })` removes the task's worktree; plain
  `dispose()` does nothing.

**Not verified — needs a real remote host to exercise:**

- That an actual `ssh` binary accepts the argv this provider builds (quoting
  correctness against a live OpenSSH client/server, not just against the
  fake `host.exec` recorder).
- That `ssh -t ... tmux attach ...` actually streams a usable interactive
  session into xterm.js end-to-end.
- Real clone/fetch behavior against a real git remote — auth prompts,
  network failures, partial clones, disk space on the remote box.
- Whether `settings.compute["ssh:ssh"].secrets.identityFile` actually reaches
  this provider's `ctx.secrets` in a running server. `computeConfigFor()`
  (`server/settings.ts`) implements that resolution, but whether
  `server/compute/index.ts`'s `resolveComputeContext()` calls it — as opposed
  to the `secrets: {}` stub it shipped with — depends on a sibling wave of
  this same change landing. If your `ssh -i` flag isn't showing up, check
  that first.
- Remote-box resource limits, concurrent-task behavior on one box, and
  cleanup of the shared clone at `<root>/repos/<name>` (never removed by this
  provider — only per-task worktrees are).
