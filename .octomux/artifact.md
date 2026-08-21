## Summary

_Updated 2026-08-21 05:01:48_

Bash: ./dist-bin/octomux task move --id 4cielUXT7E4A --workflow-status human_review --note "SHR-259…

## What this is not

A plugin runs in-process with the DB handle, every credential, and `process.env`.
It can do everything core can do without ever touching `ctx`. A capability grant
confines nothing — it is a **coordination and audit mechanism**: it records what a
plugin claims to need, enforces that claim at core's own seams, and makes it
reviewable. `octomux plugins approve` is an operator confirming intent, not a
security check on the code. Real containment is out-of-process compute, which is
not this ticket. Nothing in the code or the docs claims otherwise.

Not advertised on octomux.com — this is infrastructure, not a marketed seam.

## Proof

`server/plugins/integration.test.ts` drives a real plugin module off disk through
the real `loadPlugins()`:

- a plugin calling `ctx.policy` without the grant fails to load, with a message
  naming plugin, capability, and the manifest line that fixes it
- a granted plugin denies a `task.launch`, and the deny lands both as a
  `core:policy.decision` fact and as a `policy` row in task history
- a plugin rewrites the model on the way through
- a grant added to an already-acknowledged row is withheld until approved

Nothing in `server/` registers a policy hook, so only code from outside core can
have produced those refusals.

## Verification

`bun run typecheck` clean · `bun run format:check` clean · `bun run lint` 0 errors ·
`bun run test` = 3423 + 1291 + 223 pass, 0 fail.

## Left out / want challenged

1. **No `task.merge` point** — the ticket names one; there is no core merge call
   site to gate. Say so if you want the merge path invented here.
2. **Fail-open** means a broken policy plugin is silently inert. A hook author who
   wants "unreachable = deny" has to encode that themselves.
3. **"Prompts on next boot"** is implemented as withhold + report + explicit
   `plugins approve`, not an interactive prompt — a server boot has no tty.
4. **`respawn-agent` / `add-agent` are not gated.** Different verbs, different error
   surfacing. If a loop iteration counts as a launch, that's a gap.
5. `assertGranted`'s fix hint prints `grants: [<cap>]` without merging the grants
   the row already has — the user appends by hand.
6. Grants are enforced at `ctx` only, by construction (see "What this is not").
7. I ran `bun install` in this worktree. There was no `node_modules` here, so `tsc`
   resolved `@octomux/*` against the parent repo's stale copies and `bun run
   typecheck` could never have passed. Gitignored, but worth knowing.
