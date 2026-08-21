# SHR-275 — `ctx.collections`

Commit `16b7846`. `bun run typecheck` / `format:check` / `lint` clean; full
suite green (3663 + 1301 + 223, 0 fail).

## What shipped

`ctx.agents.run({ input, outputSchema, model?, timeoutMs?, workspaceDir? })` → `Promise<T>`,
gated on a new `agents.run` capability.

- **`packages/plugin-api/src/index.ts`** — `AgentRunOptions` + `AgentRunner`,
  `readonly agents: AgentRunner` on `PluginContext`, `'agents.run'` on the
  `PluginCapability` union. **No `PLUGIN_API_VERSION` bump** (decided: additive, and
  SHR-273 added two capabilities the same week without one).
- **`server/plugins/grants.ts`** — `'agents.run'` in `PLUGIN_CAPABILITIES`. Both places,
  or the manifest validator rejects the grant name.
- **`server/plugins/context.ts`** — a thin accessor over the existing `runAgentSession()`:
  default harness (`getHarness(null)`) + `ptySubstrate`, exactly what
  `services/session-vertical-service.ts` already does for scheduled kinds, minus the
  `run:` option — so a plugin run stays DB-free and gets no `runs` row.
  `workspaceDir` defaults to `fs.promises.mkdtemp()` and is removed in a `finally`;
  a caller-supplied dir is used verbatim and left alone.
- **Explicitly git-free.** No worktree, no branch, no tmux session. The empty scratch
  dir is also a clean room — no CLAUDE.md, no repo, no project skills in the prompt.
- **No concurrency cap**, per the ticket — SHR-276 (fan-out) owns the limiter and a
  second one here would compete with it.
- Docs: `CLAUDE.md`, `docs/plugins/api-reference.md`, `create-plugin` + `add-plugin`
  SKILL.md.

## Tests

`server/plugins/agent-runner.test.ts` (7, new) drives the **real** `runAgentSession` —
only `getHarness` and `ptySubstrate` are stubbed, `fs` is real:

1. result returned **unwrapped**, and the caller's `outputSchema` is what reaches the
   generated submit-result MCP config
2. `timeoutMs: 50` rejects with `/timed out/` and disposes the handle — no hang
3. ephemeral dir: under `os.tmpdir()`, named `octomux-plugin-<id>-*`, empty at spawn,
   gone after settle
4. caller-supplied `workspaceDir` used verbatim and NOT deleted
5. git-free (no `.git` in the spawn cwd)
6. `disposePluginContext` returns in <150ms without waiting out an in-flight run's
   timeout; the in-flight run still settles; a run started after disposal rejects
7. no `runs` row written

Plus grant-denial coverage in `context.test.ts` (the no-grants registrar sweep and the
`it.each` one-grant table).

Green: 3599 / 1294 / 223 pass, 0 fail. `typecheck`, `lint`, `format:check` clean.

## Please challenge

1. **`run()` IS gated on `assertLive`**, unlike `facts.put` / `artifacts.write`, which
   deliberately are not. Reasoning: those flush output the plugin already earned;
   this spawns a subprocess. Side effect — a context revoked by an `apply()` timeout
   can no longer run agents. I think that's right; it is a deliberate divergence.
2. **Disposal does not cancel an in-flight session**, only blocks new ones. In-flight
   runs settle on their own (`runAgentSession` disposes the handle in a `finally`,
   `timeoutMs` bounds the wait). Real cancellation needs an `AbortSignal` on
   `runAgentSession` — judged out of scope, not forgotten.
3. **No ceiling on `timeoutMs`.** A plugin can pass `Infinity` and pin a pty forever.
   A plugin can also just spawn its own subprocess, so a cap here is theatre — but
   say so if you'd rather have one.

## Environment note (recurring, not caused by this change)

This worktree had **no local `node_modules`**, so `@octomux/*` resolved up to the main
checkout's `packages/`, and `bun run typecheck` silently validated against stale types —
it reported "no exported member `AgentRunner`" long after the type existed. `bun install`
in the worktree fixes it. SHR-261's artifact recorded the same trap; it keeps biting
every worktree-based task.

Also: there is no `octomux task rename` in the installed CLI, and
`PATCH /api/tasks/:id` refuses with `Can only edit fields on draft tasks`, so the task
title is unchanged (it was already accurate). `octomux task-summary` 404s — that route
was retired on this branch, which is why this narrative lives here.

## Summary

_Updated 2026-08-21 15:49:09_

Write: /Users/shreypaharia/Documents/Projects/octomux-agents/.worktrees/shr-272-ctx-agents-run-head…
