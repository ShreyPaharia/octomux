# SHR-267 — `ctx.surfaces`

Commit `aaef24b`. **Not merged** — human reviews and merges.

## What shipped

- **`ctx.surfaces.register({ kind, renderers, fallback, render, prompt })`** — the
  eighth registrar. Gated on a new `surfaces.register` capability (added to both
  `PLUGIN_CAPABILITIES` in `server/plugins/grants.ts` and the `PluginCapability`
  union in `@octomux/plugin-api`, so the manifest validator accepts it). Kind is
  qualified to `<pluginId>:<kind>`; deregistered on unmount alongside compute and
  harnesses.
- **`server/surfaces/`** — `registry.ts` (mirrors `compute/registry.ts` exactly:
  warn-and-keep-first, `freezeCoreSurfaces()`, core kinds un-unregisterable),
  `core.ts` (`web`/`cli`/`slack`/`telegram` as `CORE_SURFACE_KINDS`), `text.ts`
  (one plain-text renderer shared by the three server-rendered core surfaces),
  `render.ts` (resolution + fact loading + fail-soft render), `index.ts` (barrel
  that registers and freezes at module scope).
- **Renderer contract.** A surface declares the renderer names it draws. The host
  resolves `panel.as` → `panel.renderer` _before_ calling `render`: the declared
  renderer when supported, otherwise the surface's `fallback` (default `json`).
  Degraded, never dropped, never blank — the same rule the web client always
  applied to an unknown renderer name. `render` throwing skips that one panel.
- **Read-only surfaces.** `prompt` is optional; without it the surface is read-only
  and `promptOn()` throws naming it. A question nobody can answer is a wedged run,
  not a degraded one, so it is never swallowed.
- **REST.** `GET /api/surfaces`; `GET /api/tasks/:id/panels?surface=<kind>`; an
  optional `?surface=` on the existing contributions endpoint (byte-identical
  without it — that is the no-behaviour-change proof for web).
- **`server/surfaces/portability.test.ts`** is the ticket's actual claim: a binding
  `coverage-bot` registered when no Discord surface existed renders on a
  later-registered `demo:discord` (`stat` → `markdown` fallback) _and_ on `cli`
  (`stat` native). Unregistering the surface leaves the binding in the contribution
  table, still rendering on `cli` — removed surface degrades, panels are not
  orphaned.
- **Docs** — `CLAUDE.md`, `docs/plugins/{README,api-reference}.md`, and
  `docs/plugins/examples/discord-surface/` (registers a surface that is _not_
  read-only; its Discord network calls are an explicitly-marked stub, not fake
  working code).

Verified: `bun run typecheck` clean, `bun run format:check` clean, `bun run test`
green — 3631 server / 1294 client / 223 unit.

## Not done — please challenge

1. **All four core surfaces are read-only.** No core `prompt` implementation exists.
   octomux's only human-question path is the card-based approval gate
   (`server/orchestrator/gate.ts`), DB-backed and untouched here — rewriting it onto
   `surfaces.prompt` is a real migration with real risk and no ticket requirement.
   `prompt` is exercised only by the example plugin and tests. Challenge me if you
   wanted `slack.prompt` wired to block-actions.
2. **Honest accounting of step 1's "migrate with no behaviour change".** Only `web`
   had an existing panel path to move, and it was kept byte-identical without
   `?surface=`. `cli`/`slack`/`telegram` had **no** panel rendering before this —
   registering them is new capability, not migration. Calling that a migration would
   be a lie.
3. **The gateway's `ChannelAdapter.id: 'telegram' | 'slack'` union was NOT widened**
   onto the registry. High blast radius on a default-deny security surface, zero
   payoff today. That closed union is still the thing an out-of-tree chat channel
   would hit first.
4. **`web` omits `render` entirely** (the browser owns rendering), but the plugin
   registrar _requires_ it. Deliberate and documented, but it is the one place the
   contract is not uniform.
5. **`WEB_RENDERERS` is hand-synced** with `src/workflows/renderers/index.tsx` —
   `server/` cannot import from `src/`. No test enforces the sync.
6. **No CLI command consumes the `cli` surface.** `GET /api/tasks/:id/panels?surface=cli`
   is its only call site. A future `octomux panels <task>` is one thin command away.
7. **`panelsForSurface` loads facts per contribution serially** — N queries per
   render. Fine at current panel counts; batch if a task ever carries many bindings.

## Changed without being asked

- `server/registry/route-inventory.test.ts` gained `GET /api/surfaces` and
  `GET /api/tasks/:id/panels` in `PENDING_MIGRATION` — that file's designed
  onboarding mechanism for a new route, not a workaround.
- This worktree had no `node_modules`, so `@octomux/*` resolved _up_ to the main
  checkout's `packages/`. Ran `bun install`; typecheck was silently reading the
  wrong `@octomux/plugin-api` before that.

## Housekeeping

A stale `stash@{0}` on this branch is a mid-run snapshot from an earlier agent; the
working tree supersedes it. Left alone rather than dropping someone else's stash.
