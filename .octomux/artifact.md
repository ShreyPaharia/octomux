## What shipped

- **`server/compute/`** — `ComputeProvider {kind, create, resume?}` +
  `ComputeSession {kind, taskId, repoPath, exec, tmux, spawn, files, dispose}`.
  Registry mirrors `harnesses/registry.ts` (`DEFAULT_COMPUTE_KIND='local'`, core
  frozen before plugins load). `sessionFor(task)` is the single entry point,
  cached per `task.id` — which is why nothing up the call stack needed a new
  parameter threaded through it.
- **Full task-engine migration**: `git.ts`, `setup/*`, `launch.ts`, `lifecycle/*`,
  `cleanup`, `sessions`, `reconcile`, `terminals`, `loop/*`, `poller/status`,
  `poller/terminal-activity`, `terminal.ts` (pty attach), `tmux-input`.
  Verified: **zero `execTmux()` and zero `fs.*Sync` remain** in `server/task-engine`,
  `server/poller`, or `server/terminal.ts`.
- **Per-task selection**: `tasks.compute TEXT` (NULL → local, no backfill),
  `POST /api/tasks {compute}`, `octomux create-task --compute <kind>` (generated
  from the zod schema — no CLI file touched), `settings.defaultComputeKind` /
  `settings.compute[kind]`.
- **Credential brokering**: `computeConfigFor(kind)` splits `settings.compute[kind]`
  into `config` + `secrets`, expands `${env:VAR}` in both (reusing the existing
  integrations convention), and hands the result to `provider.create()` only.
- **`ctx.compute.register()`** on `PluginContext`, qualified `<pluginId>:<kind>`,
  unregistered on unmount alongside harnesses/providers.
- **Out-of-core proof**: `docs/plugins/examples/ssh-compute/` — a real SSH provider,
  ~320 lines, zero deps, zero host imports. Providers get `ctx.host.{exec,spawnPty}`
  and `ctx.execBackedFiles(exec)`, the only runtime crossing the types-only
  `@octomux/plugin-api` boundary.
- **`server/compute/plugin-seam.test.ts`** is the done-when test: a provider
  registered through `ctx.compute` is selected by `tasks.compute`, and real
  task-engine helpers (tmux window launch, worktree file writes) land on _that_
  provider rather than the local machine.

## Not done — please challenge

1. **"Runs a task to completion on a different machine" is NOT verified.** There is
   no sshd on this box (`ssh localhost` refused), so the SSH provider is proven only
   against a fake transport: argv/quoting, clone-vs-fetch, dispose, and the
   credential invariant (the `identityFile` secret appears only in the `ssh -i` pair,
   never in a remote command or env). Real OpenSSH, real remote `tmux attach` into
   xterm.js, and real auth are untested. This is the one DoD bullet I cannot claim.
2. **`resume()`** is registered and called, but the host can't yet distinguish
   "reattach after restart" from "first create", so it falls back to `create()`.
   Needs the restart-reconcile path.
3. **`hop-agent` now refuses** to move an agent between tasks on different compute
   kinds rather than silently launching a blank session that looks like a resume.
   No-op today (only `local` exists). Challenge if you'd rather it degrade than throw.
4. **`localExec` uses `promisify(execFile)` on its no-stdin path** and the raw
   callback form only when `opts.input` is set. Not stylistic: a mocked `vi.fn()`
   loses execFile's `promisify.custom`, so going all-raw-3-arg would have silently
   broken every still-promisify-based consumer sharing the same mocks. Documented in
   the function — worth a second opinion.
5. **`chats.ts` and `orchestrator/**`are deliberately outside the seam** (no`Task`
   — task-free by design) and always run local. Conductor conversations on remote
   compute is separate work.

## Changed without being asked

- `ComputeFiles` gained `chmod()` and `mkdirp(mode)`. Without it the cursor harness's
  `.octomux-hooks` dir silently dropped from 0700 to umask, and mode stopped being
  enforced when rewriting an existing secret-bearing file. Regression test added.
- Fixed a pre-existing bug found en route: `pollAgentWindows` sent the notify-target
  message via the **finishing worker's** compute rather than the notify target's own
  — different tasks.
- Moved `computeConfigFor` from `settings.ts` to `server/compute/config.ts` (it's
  compute's concern, and `settings.ts` is partially mocked in ~14 suites).
- This worktree had no `node_modules`, so `@octomux/*` resolved up to the main
  checkout's stale `dist/`. Added gitignored symlinks under `node_modules/@octomux/`.

## Housekeeping

A stale `stash@{0}` on this branch is a mid-run snapshot an agent took; the working
tree supersedes it. Left it rather than dropping someone else's stash —
`git stash drop stash@{0}` is safe.

## Summary

_Updated 2026-08-21 04:49:16_

Bash: cat > /private/tmp/claude-501/-Users-shreypaharia-Documents-Projects-octomux-agents--worktree…
