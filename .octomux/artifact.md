## What shipped

Three doc files plus one drift guard.

### 1. Capability grants, documented for the first time

`grants` appeared **zero times** in `docs/plugins/`. Grants are deny-by-default, so a
reader who followed `README.md` exactly got a load failure on their first boot. Now:

- `docs/plugins/README.md` §Capability grants (right after Quickstart, because it's the
  first thing that breaks) — the 15-name table, how to derive the grants you need from
  your `ctx.*` calls, the widen/approve flow, "not a sandbox".
- `docs/plugins/api-reference.md` §Capability grants — the same model at reference depth,
  plus `grants?` on the `PluginRow` snippet and `grants?`/`pendingGrants?`/`loadedAt?`/
  `manifestError?` on `LoadReport`.
- Every manifest row shown to a reader now declares `grants:` — Quickstart, both
  in-guide registrar examples, and both broken example plugins.

### 2. Six missing `ctx` sections

`ctx.http`, `ctx.facts`, `ctx.ui`, `ctx.artifacts`, `ctx.policy`, `ctx.effect()` — each
with its interface, the capability that gates it, what deregisters on unmount, and an
example. `## PluginContext` now carries an 18-row member table.

`README.md` §"The three registrars" was renamed — there are ten registrars, four methods
on `ctx`, and four plain members.

### 3. `## Not seams` rewritten

From one paragraph about `ctx.catalog` to the eight-item list matching the public site:
skills/agent roles, MCP, models, history, artifacts, catalog, isolation, storage.

### 4. `server/plugins/docs.test.ts`

Derives its expectations from source rather than restating them: parses `PluginContext`
out of `@octomux/plugin-api`, reads `PLUGIN_CAPABILITIES`, and calls the real
`assertGranted` to get its current error wording. Asserts every member has a section,
every capability name appears in both docs, the docs quote the live error text, and every
manifest row shown to a reader declares `grants:`. Example READMEs are discovered, not
listed — a new example can't opt out.

## Found while working

**`resume()` shadows `create()`.** `sessionFor()` (`server/compute/index.ts:78`) is
`provider.resume ?? provider.create`. A provider defining both — like the `ssh-compute`
example — gets `resume()` on a brand-new task's first session, so its clone/fetch path is
unreachable via `startTask` and `resume()` throws "found no clone". The root `CLAUDE.md`
says the host "falls back to `create`", which reads the opposite way. Documented as a
trap in the example's README; the example's runtime behaviour was left alone (fixing it
means deciding resume semantics, which belongs with the restart-reconcile wave).

**`.octomux/artifact.md` added to `.prettierignore`.** It's rewritten by the harness on
every tool call, so it failed `format:check` on a timestamp that was stale before the
check finished.

## Summary

_Updated 2026-08-21 18:26:55_

Bash: bun run lint 2>&1 | tail -5; echo "=== typecheck ==="; bun run typecheck 2>&1 | tail -3; echo…
