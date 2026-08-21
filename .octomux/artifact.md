## What shipped (commit `4e9c2cb`)

`ctx.fanout` — a plugin maps a handler over an item source and gets back per-item
status, bounded retry, dead-lettering, and a redrive path.

```ts
run(spec): Promise<FanOutRunSummary>   // gated: new capability 'fanout.run'
status(runId), list(name?)             // ungated reads, matching facts.read
source: { items } | { collection, query } | { resume: runId }
```

| File | What |
| --- | --- |
| `packages/plugin-api/src/index.ts` | `FanOutApi`/`FanOutSpec`/`FanOutSource`/summary+item shapes, `ctx.fanout`, `'fanout.run'` capability |
| `server/plugins/grants.ts` | `'fanout.run'` in `PLUGIN_CAPABILITIES` (both places, per the ticket) |
| `server/plugins/fanout.ts` | engine: scheduler, global semaphore, retry/backoff, dead-letter, abort |
| `server/repositories/fanout.ts` + `db/migrations.ts` | `fanout_runs` / `fanout_items` |
| `server/routes/fanout.ts` | `GET /api/fanout/runs`, `GET /api/fanout/runs/:id` |
| `server/plugins/context.ts` | grant gate on `run`, ungated reads, abort-on-unmount effect |
| `server/settings.ts` | `settings.fanout.maxConcurrency` (default 4) |
| CLAUDE.md, `docs/plugins/api-reference.md`, create-plugin SKILL.md | docs |

### The cross-ticket decision, honoured

**The concurrency cap lives here and it is GLOBAL.** One module-level semaphore
shared by every plugin's every run, sized by `settings.fanout.maxConcurrency`. A
per-run `concurrency` is clamped *down* to it, never up — three plugins asking
for 4 each get 4 total, not 12. `ctx.agents.run()` (SHR-272) needs no cap of its
own and stays a thin accessor.

Tested directly: two simultaneous runs from two different plugins, each
requesting `concurrency: 5`, against a host limit of 2 — observed peak in-flight
handlers never exceeds 2.

### SHR-275 dependency

Not implemented here. The engine exposes `setCollectionResolver(fn)`; until
`ctx.collections` injects one, a `{ collection }` source throws a message naming
SHR-275 and telling you to pass `{ items }`. One line to wire when it lands.

### Verification

`typecheck` clean · `format:check` clean · `lint` 0 errors · `test:server`
3627 pass / 0 fail (32 new: 13 repository, 12 engine, 5 routes, 7 context-wiring)
· `test:client` 1294 pass · `test:units` 223 pass.

## Left out, deliberately

- **Step composition / DAG** — out of scope per the ticket. Chain via a collection.
- **The declarative tier.** The ticket lists "a home-tier kind preset that can say
  *for each record matching this query, run this prompt*" as motivation, not under
  Build. Nothing here is reachable from `~/.octomux/kinds/*.json` — fan-out is
  still a TypeScript-plugin-only capability. This is the gap between "a plugin can
  build a pipeline" and "a non-programmer can".
- **No HTTP redrive route.** A redrive needs the plugin's live `each` closure,
  which cannot be persisted, so redrive is
  `ctx.fanout.run({ source: { resume } })` from inside the plugin. A plugin can
  expose a button in three lines via `ctx.http.route`.
- **No pruning of `fanout_runs`.** A daily 60-item cron adds ~61 rows/day. Fine
  for years, unbounded in principle.
- **No UI.** The two GET routes make a run legible; nothing renders it.

## What I want challenged

1. **`run()` resolves on abort** with `status: 'canceled'` rather than rejecting,
   and does not await in-flight handlers (a handler may be a five-minute agent
   session, and unmount must not block on it). Late handler results are silently
   dropped via `signal.aborted` guards. Is silent-drop right, or should an aborted
   run reject?
2. **Every `{ items }` run creates a NEW run row.** Re-running the same
   name + items does not resume, it redoes the work; resume is explicit via
   `{ resume }`. Is implicit resume-by-name the more useful default?
3. **Item identity defaults to a sha1** of a key-sorted stringify, which silently
   collapses duplicate items into one row. Should an unkeyed duplicate be an
   error instead?
4. **`setLimit()` is called per run** from freshly-read settings, so a settings
   change affects runs already in flight. Shrinking throttles gradually rather
   than evicting holders. Reasonable, or surprising?
5. **`assertGranted` sits in `context.ts`**, matching `facts.put` /
   `artifacts.write`, not in the engine — so the engine's functions are callable
   ungated by core. Consistent, or a footgun?

## Environment note (not part of the diff)

This worktree had no `node_modules`, so Node/tsc walked up and resolved
`@octomux/plugin-api` to the **main checkout's** stale `dist/index.d.ts` — every
`FanOut*` type looked missing and it read like a code bug. Fixed by symlinking
`<worktree>/node_modules/@octomux/*` at this worktree's own `packages/*`.
Gitignored, so it is not in the commit. Any parallel worktree on this repo will
hit the same thing.

## Summary

_Updated 2026-08-21 16:16:43_

Write: /Users/shreypaharia/Documents/Projects/octomux-agents/.worktrees/shr-276-fan-out-run-a-step-…
