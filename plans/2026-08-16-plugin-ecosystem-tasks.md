# Plugin Ecosystem — Executable Tasks

> Execution breakdown for `plans/2026-08-16-plugin-ecosystem.md`. STEP-0 is one
> sequential agent that pins every contract; everything after it runs in parallel
> with disjoint file sets. The bun migration is happening concurrently — every task
> here is verified free of `better-sqlite3`, `node-pty`, and `getDb()` surface.

**Held until the bun migration lands** (same files, would be written twice):
W1-A packaging/publish, W1-D DB safety net + `plugin_kv`. Do not schedule them.

---

## STATUS — all three steps shipped

Landed on `next` at `0a13108`. **3212 server + 1265 client + 205 unit passing,
0 fail; `tsc -b`, lint and format clean.**

| Step   | Tasks                            | Landed                                            |
| ------ | -------------------------------- | ------------------------------------------------- |
| STEP-0 | foundation                       | `b211532`                                         |
| STEP-1 | T1 T2 T3 T4 T5 (parallel)        | `766651f` `8c737fe` `2a3c2d7` `0ccdfcb` `be6e04c` |
| review | 4 Critical + 7 Issues, all fixed | R1–R4, `8c73180`…`02efa7b`                        |
| STEP-2 | T7, T6, T8                       | `3e8e477` `8f78541` `4e604d7`                     |

### Corrections to the text below

The task text is left as written for provenance. These four turned out wrong:

| Said                                     | Actually                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `bin/octomux.js` owns `--safe-mode`      | `bin/main.js` — `bin/octomux` is a launcher that execs the binary |
| `updatePluginSettings → OctomuxSettings` | `Promise<void>`                                                   |
| the plugin namespace is the package name | the manifest row's `id` (`name` may be a path or contain `/`)     |
| `pluginKindsDir()` takes no argument     | `pluginKindsDir(pkg)`; the directory scan was deleted outright    |

### What the parallel split actually cost

Five concurrent agents plus a foundation agent produced **three cross-task seams**
`tsc -b` caught at merge, all in test files, none in production code. Worth the
wall-clock. The recurring failures were procedural, not technical:

- every agent worktree was branched from **main's release history, not `next`** —
  six independent recoveries of the same harness bug
- `bun test <directory>` **hangs** without `--parallel`; two agents burned ~15 min
  each looping on it, and stray processes survived to slow later runs. Always name
  individual files, always prefix `timeout 120`.
- `vi.useFakeTimers()` around an awaited dynamic `import()` **deadlocks**:
  `advanceTimersByTimeAsync` returns before the timer is scheduled, then the code
  waits on a timer that never fires. Use a small real timeout.

### Still open

- `plugins disable`/`enable` re-serializes the whole YAML — comments, key order
  and formatting in a hand-edited `octomux.yml` are destroyed on first write
- the CLI is outside `tsc -b` entirely (root tsconfig never references
  `cli/tsconfig.json`), and `cli/src/commands/{plugins,doctor}.ts` now reach into
  `server/plugins/*` by relative path
- `server/index.test.ts` asserts boot order by reading source text, not by
  executing it — `index.ts` binds a port on import
- W1-A (publish) and W1-D (`plugin_kv`, which `ctx.kv` throws for) still held

---

## Post-rebase deltas (the bun migration landed on `next`)

Rebased on `origin/next` @ `adbee6b`. Four things changed that every task below
inherits — **CLAUDE.md is stale on the first two**:

| Was                        | Now                                                                  |
| -------------------------- | -------------------------------------------------------------------- |
| vitest                     | **`bun test`** — `import … from 'bun:test'`, `mock`/`spyOn` not `vi` |
| `bun run test` = one suite | three: `test:server`, `test:client`, `test:units`                    |
| `better-sqlite3`, node-pty | `server/sqlite.ts`, `server/pty.ts` shims                            |
| ad-hoc `import.meta.url`   | `assetRoot()` in `server/assets.ts` for bundled assets               |

Run only your own slice: `NODE_ENV=test bun test ./server/<yours> --timeout 15000`.

Baseline before STEP-0: **3082 server + 1263 client + 233 unit passing, 0 fail,
`tsc -b` clean.** Any failure you see that isn't in your own files is yours to
report, not to fix.

S2 still stands — `assetRoot()` solved the _bundled asset_ case, but the eleven
files listed below still derive disk paths from `import.meta.url`, and plugin
paths must not join them.

---

## Spike results — unknowns, now known

Four things were tested before writing these tasks. Two changed the design.

### S1 — one loader works across node, bun, and `bun --compile` ✅

`createRequire(path.join(PREFIX, 'anchor.js')).resolve(name)` resolves a bare
package name identically in all three runtimes, and `await import(<abs path>)`
works in all three. A plugin's **own nested `node_modules` resolves** — a fixture
plugin importing `demo-dep` from its own tree loaded and ran under each.

Layout that works: `<prefix>/node_modules/<pkg>/` with the plugin's own deps
nested beneath it.

### S2 — `import.meta.url` is a trap under `--compile` ⚠️ **affects the bun workstream**

Inside a compiled binary, `import.meta.dirname` is **`/$bunfs/root`** — the virtual
filesystem embedded in the executable, not the real disk. v1 of the spike derived
the plugin prefix that way and every load failed with
`Cannot find module '/$bunfs/root/plugins/...'`.

Any disk path must come from an env var, `os.homedir()`, or `process.execPath`.

**This is not a plugin problem — it is a pre-existing landmine for `bun --compile`.**
Eleven non-test files derive disk paths this way today:

```
server/octomux-paths.ts   server/tmux-bin.ts        server/db.ts
server/logger.ts          server/octomux-plugin.ts  server/remote-auth.ts
server/hook-dispatcher.ts server/hooks-install.ts   server/index.ts
server/setup-status.ts    server/harnesses/cursor.ts
```

`octomux-plugin.ts` (walks up 6 levels for the bundled plugin dir) and `cursor.ts`
(walks up 6 levels for `bin/octomux-hook-bridge.js`) are the two that throw rather
than silently misresolve. **Hand this to whoever owns the bun migration** — it is
larger than sqlite and PTY combined and nothing else has flagged it.

### S3 — `checkPresetShape` rejects a qualified kind ✅ design forced

```
KIND_NAME_RE accepts "demo:changelog"? false
  bare kind, matching stem     -> accepted
  qualified kind in the FILE   -> REJECTED: must match ^[a-z0-9][a-z0-9-]*$
  qualified kind, bare stem    -> REJECTED: must match ^[a-z0-9][a-z0-9-]*$
```

So a plugin's `kinds/*.json` declares a **bare** kind and the loader qualifies it
**after** validation. The author never writes their package name into the file, and
`KIND_NAME_RE` stays untouched as the traversal guard.

### S4 — registration after `createApp()` cannot work ✅ by inspection

`server/api.ts:47` iterates `listWorkflows()` inside `setupRoutes`, which
`createApp()` calls synchronously. It is a snapshot by construction. The
boot-order contract in the plan holds.

---

## STEP-0 — foundation (ONE agent, sequential, blocks everything)

Pins every contract the parallel tasks compile against. Nothing else may start
until this is merged.

**Owns (all new files — no collisions possible):**

```
packages/plugin-api/package.json
packages/plugin-api/tsconfig.json
packages/plugin-api/src/index.ts
server/plugins/qualify.ts          + qualify.test.ts
server/plugins/manifest.ts         + manifest.test.ts
server/plugins/paths.ts            + paths.test.ts
```

**Must NOT touch:** anything else. Not `server/index.ts`, not `package.json` (root),
not `octomux-paths.ts`.

### Deliverable 1 — `packages/plugin-api/src/index.ts`, types only

Copy the `PluginContext` / `PluginLogger` / `PluginSettingsScope` / `PluginKv` /
registrar / `PluginRow` / `PluginManifest` / `LoadedPlugin` / `LoadReport`
definitions verbatim from the plan's "Pinned interfaces" section, plus
`export const PLUGIN_API_VERSION = 0;`.

Hard constraint: **no runtime exports beyond that one const.** Add a test asserting
the built `dist/index.js` is empty or `export {}` apart from the version const. Do
not add it to the root `package.json` workspaces or `files:` — W1-A owns publishing
and is on hold.

### Deliverable 2 — `server/plugins/qualify.ts`

```ts
export const QUALIFIED_KIND_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
/** `@foo/bar` -> `foo-bar`; `octomux-plugin-x` -> `octomux-plugin-x`. */
export function sanitizePackageName(pkg: string): string;
/** `qualify('demo', 'changelog') === 'demo:changelog'`. Throws on a local id that
 *  fails KIND_NAME_RE, or a sanitized package that does. */
export function qualify(pluginId: string, localId: string): string;
```

`KIND_NAME_RE` in `server/workflows/presets.ts` **stays exactly as it is** — it is
the path-traversal guard for `PUT`/`DELETE /api/kinds/:kind`. Import it, don't edit
it. Tests must cover: scoped names, uppercase rejected, `..` rejected, a qualified
string never matching `KIND_NAME_RE`.

### Deliverable 3 — `server/plugins/paths.ts`

```ts
/** Plugin install root. OCTOMUX_PLUGIN_PREFIX, else octomuxRoot(). */
export function pluginPrefix(): string;
/** <prefix>/node_modules — the resolution anchor (see S1). */
export function pluginModulesDir(): string;
/** Kind presets shipped by installed plugins: <prefix>/node_modules/<pkg>/kinds. */
export function pluginKindsDir(): string;
/** Manifest path. OCTOMUX_PLUGIN_MANIFEST, else <octomuxRoot()>/octomux.yml. */
export function manifestPath(): string;
```

**Never derive any of these from `import.meta.url`** — see S2. `octomuxRoot()` is
already env-overridable and safe. Add a comment saying why, with the `/$bunfs/root`
evidence, so nobody "simplifies" it later.

### Deliverable 4 — `server/plugins/manifest.ts`

Parse + validate only. **No loading, no `import()`** — that is W2-A.

```ts
export function parseManifest(text: string): PluginManifest; // throws on bad shape
export function readManifest(file: string): PluginManifest; // missing file -> { plugins: [] }
```

Rules, each with a test: unknown top-level keys rejected; duplicate row `id`
rejected; `id` must match `KIND_NAME_RE`; a row with neither `name` nor an absolute
path rejected; **any YAML tag/expression node rejected** (dsh postmortem 0002 — an
uninterpolated `!!js` expression read as truthy and silently disabled their whole
filesystem tool stack); `disabled: true` rows parse but are marked.

### Deliverable 5 — `createTestHost` in `server/test-helpers.ts`

The one exception to "new files only". Append:

```ts
export function createTestHost(opts?: { plugins?: Array<{ id: string; mod: unknown }> }): TestHost;
```

Takes plugin **objects**, never package names, so unit tests never touch the
filesystem. Do not modify `createTestDb` or anything else in the file.

**Done when:** `bun run typecheck` clean, new tests pass, and
`grep -rn "import.meta" server/plugins/` returns nothing.

---

## STEP-1 — five parallel tasks

Dispatch after STEP-0 merges. File sets verified disjoint. Every task: work in your
own worktree, `cd` to its absolute path first, do not commit, run only your own
tests, do not run repo-wide `typecheck`.

### T1 — plugin kinds tier

**Owns:** `server/workflows/presets.ts`, `server/workflows/presets.test.ts`,
`server/routes/kinds.ts`, `server/routes/kinds.test.ts`

Add a third scan tier between built-in and home: built-in → **plugin** → home
(home still wins). Source directory is `pluginKindsDir()` from STEP-0 — import it,
do not compute paths yourself.

Per S3, a plugin's `kinds/*.json` declares a **bare** kind that must match its
filename stem, exactly like the other tiers. Qualify to `<pkg>:<kind>` with
`qualify()` **after** `checkPresetShape` passes. Do not change `KIND_NAME_RE`, do
not change `checkPresetShape`.

Tests mirror the existing `home tier` describe block: registration, qualification,
precedence across three tiers, bad file warn-and-skipped (never a boot crash),
traversal-shaped package name rejected, and a plugin kind **cannot** shadow a
built-in id.

**Done when:** a fixture plugin dir produces a registered `<pkg>:<kind>` workflow.

### T2 — harness registry guards

**Owns:** `server/harnesses/registry.ts`, `server/harnesses/index.ts`,
`server/harnesses/registry.test.ts`

Add `CORE_HARNESS_IDS`, `freezeCoreHarnesses()`, and `resetHarnesses()` (tests need
it once redefinition is guarded). `registerHarness` gains a redefinition guard that
**logs a `logger.warn` and keeps the first registration** — do NOT throw yet; a boot
that hard-fails where it previously last-write-wins is an upgrade that reconciles
nobody's tmux sessions. Leave a `ponytail:` comment naming the release it becomes
fatal.

**Do not touch** `claude-code.ts` or `cursor.ts` — T5 owns those. Keep the existing
side-effect imports in `index.ts` exactly as they are.

### T3 — integration + workflow registry guards

**Owns:** `server/integrations/registry.ts`, `server/integrations/index.test.ts`,
`server/workflows/registry.ts`, `server/workflows/registry.test.ts`

`registerProvider`: `CORE_PROVIDER_KINDS` + freeze + `resetProviders()`, same
warn-don't-throw policy as T2.

`registerWorkflow`: **must NOT get a duplicate guard.** `presets.ts` deliberately
re-registers existing kinds to overlay preset metadata, and `reloadPresets()` runs
again on every UI kind write — a guard breaks kind editing. Add
`registerPluginWorkflow(qualifiedKind, wf)` instead, which rejects unqualified ids
and any core kind. Write that asymmetry into the file header.

**Do not touch** `server/integrations/index.ts` (its four side-effect imports are
W3-A's, later) or `server/workflows/presets.ts` (T1's).

### T4 — `settings.plugins[id]`

**Owns:** `server/settings.ts`, `server/settings.test.ts`,
`server/routes/settings.ts`

Add `plugins: Record<string, Record<string, unknown>>` to `OctomuxSettings` **and
to both allowlist literals** — the `getSettings` return shape and the
`updateSettings` merge. Unknown top-level keys are destroyed on write today; only
`harnesses` survives, via an explicit branch. Mirror that branch for `plugins`:
unknown plugin ids preserved verbatim, no validation.

Export `getPluginSettings(id)` / `updatePluginSettings(id, patch)`, both **async** —
`getSettings()` is async and dynamically imports the harness barrel; there is no
sync full read.

While sole owner, delete the dead `resolveClaudeFlags` (referenced only by tests).

### T5 — harness interface surface

**Owns:** `server/harnesses/types.ts`, `server/harnesses/types.test.ts`,
`server/harnesses/claude-code.ts`, `server/harnesses/cursor.ts`, and their tests

Add to `Harness`, all optional, current behaviour as the default so nothing changes
at any call site yet:

```ts
readonly supportsClaudePlugins?: boolean;
buildPromptDelivery?(baseCmd: string, promptFile: string): string;
attachMcp?(flags: string, worktreePath: string, configPath: string): string;
sendMessage?(target: string, text: string): Promise<void>;
detectActivity?(target: string): Promise<'active' | 'idle'>;
```

Remove `syncAgents` from the interface **and** from both implementations — it is an
empty no-op in both and `octomux-paths.ts` documents that it stays that way.

Add `export default` to both harness objects alongside the existing named exports.
**Keep the module-scope `registerHarness(...)` calls** — W2-A removes them when the
loader can replace them.

**Do not implement** any of the new optionals. Wiring them to real call sites is
WAVE-4 and touches `launch.ts`, which nobody owns yet.

---

## STEP-2 — loader spine (after STEP-1)

T6 and T7 are parallel; **T8 is sequential and last** — it owns the boot sequence.

### T6 — loader core

**Owns:** `server/plugins/loader.ts` + test

```ts
export async function loadPlugins(opts: {
  manifestPath: string; // explicit, never an implicit read
  resolveFrom: string; // pluginModulesDir()
  resolve?: (name: string) => Promise<string>; // TEST SEAM — required
}): Promise<LoadReport>;
```

Resolution per S1: absolute path → import directly; bare name →
`createRequire(path.join(resolveFrom, 'anchor.js')).resolve(name)`. `NODE_ENV=test`
with no explicit manifest ⇒ `{ plugins: [] }` and **no filesystem read at all**.

Each plugin: `try/catch` + an **injectable** timeout (tests use fake timers, never
wall-clock). A failure produces a `LoadReport.failed` row plus `logger.warn` and
**never throws** — the policy `presets.ts` already implements. Core registries are
frozen before any plugin row loads.

The `resolve` seam is not optional: without it every guard test becomes a
filesystem fixture and this task lands with no unit coverage.

### T7 — plugin context

**Owns:** `server/plugins/context.ts` + test

Builds the `PluginContext` a plugin receives. `ctx.logger` is
`childLogger('plugin:' + id)`, pre-bound — plugins get no other logging path.
`ctx.settings` delegates to T4's async accessors. `ctx.kv` **throws a clear
"not available until the storage task lands" error** for now (W1-D is held for
bun); do not stub it silently.

Registrars qualify internally via `qualify()`; a plugin declares a local id and
never sees the qualified form.

### T8 — boot wiring + CLI (SEQUENTIAL, sole owner)

**Owns:** `server/index.ts`, `bin/octomux.js`, `cli/src/index.ts`,
`cli/src/commands/plugins.ts` (new), `cli/src/commands/doctor.ts` (new)

`await loadPlugins(...)` goes **between `acquireInstanceLock()` and `createApp()`**
in `server/index.ts`. There is no second window — `createApp()` snapshots the
workflow registry (S4). `createApp()` stays synchronous; ~40 supertest suites call
it directly. Call `getDb()` once before the loader so a plugin's `apply()` cannot
trigger `initDb` inside the loader's try/catch and swallow a migration failure.

`bin/octomux.js`: `--safe-mode` → `OCTOMUX_SAFE_MODE=1`. Safe mode disables plugin
rows **only** — core harnesses and providers still register.

`octomux plugins list|disable|enable` must edit the manifest **without booting the
server**, and `octomux doctor` must read a report the loader persisted to disk —
both are useless in the case they exist for otherwise.

This task owns `cli/src/index.ts` for the remainder of the plan. No other task
opens it.

---

## Integration pass — after each STEP

Orchestrator-run, sequential, not a subagent:

1. `bun run typecheck` — owns any cross-task seam fix
2. `bun run test`
3. reconcile `server/registry/route-inventory.test.ts` for the whole step —
   it asserts exact bidirectional equality over 104 entries, so any task that
   added a route collides here and **only here**
4. `bun run lint:fix && bun run format`

---

## Dispatch notes

Per CLAUDE.md: give each agent a disjoint file set, capture its worktree path with
`git worktree list` after dispatch, pass the absolute path in the prompt and tell it
to `cd` there before any file or git operation, and verify each is on its own branch
before it commits.

| Step   | Parallel? | Tasks            |
| ------ | --------- | ---------------- |
| STEP-0 | no        | foundation       |
| STEP-1 | **yes**   | T1 T2 T3 T4 T5   |
| STEP-2 | partly    | T6 ∥ T7, then T8 |

Collision check for STEP-1, verified against the tree — no file appears twice:

```
T1  workflows/presets.ts  workflows/presets.test.ts  routes/kinds.ts  routes/kinds.test.ts
T2  harnesses/registry.ts harnesses/index.ts         harnesses/registry.test.ts
T3  integrations/registry.ts integrations/index.test.ts workflows/registry.ts workflows/registry.test.ts
T4  settings.ts          settings.test.ts           routes/settings.ts
T5  harnesses/types.ts   harnesses/claude-code.ts   harnesses/cursor.ts  (+ their tests)
```
