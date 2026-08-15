# Plugin Ecosystem — Implementation Plan

> Turns octomux into a metaharness third parties extend, modelled on
> deepseek-ai/deepseek-harness ("dsh") but **not** copying its composition model.
> Reviewed by eleven adversarial personas across two rounds — six on the strategy
> (plugin author, maintainer, security, YAGNI skeptic, dsh architect, ecosystem),
> five on this document (fact-checker, implementing engineer, test owner, release
> engineer, tech lead). Every file reference was verified against the tree.

**Goal:** a third party can `npm install` a package that adds a workflow kind, an
integration provider, or a harness — without forking octomux.

**Target shape:** one mounting envelope, many capability seams. One manifest row
shape, one loader, and behind it the four _typed_ registries that already exist.
Not one unified descriptor.

---

## STOP — read this before anything else

**`octomux` has been uninstallable from npm since 1.1.0.**

```
$ npm install octomux@1.3.0
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

| Version          | `workspace:*` deps in published manifest | Installable |
| ---------------- | ---------------------------------------- | ----------- |
| 1.0.34           | 0                                        | yes         |
| 1.1.0            | 4                                        | **no**      |
| 1.2.0            | 4                                        | **no**      |
| 1.3.0 (`latest`) | 4                                        | **no**      |

`.github/workflows/publish.yml` runs `bun install` then plain `npm publish`, which
does not rewrite the `workspace:` protocol. `@octomux/api-client`,
`@octomux/diff-engine`, `@octomux/test-fixtures`, and `@octomux/types` ship as
literal `workspace:*`.

It is not only a manifest bug. tsup treats anything in `dependencies` as external,
so `dist-server/index.js` in the 1.3.0 tarball has real runtime imports from
`@octomux/types` and `@octomux/diff-engine` — packages that have never existed on
the registry. Fixing the protocol alone will not boot it.

HEAD adds a fifth break: `cli/src/index.ts` imports `@octomux/capabilities`, which
is neither a declared dependency nor published.

Nothing in CI notices, because CI only ever installs inside the repo where the
workspace symlinks resolve. `scripts/verify-build.js` regex-matches import
specifiers in `bin/octomux.js` and executes nothing.

**WAVE-0 below is a 1.3.1 hotfix. Do it before any plugin work.** It is also the
prerequisite that makes the rest of this plan verifiable rather than hopeful — and
it retroactively invalidates the demand signal this plan leans on, because the 546
downloads/month since 1.1.0 have all landed on a broken tarball.

---

## The envelope

```ts
// @octomux/plugin-api — TYPES ONLY. Nothing runtime crosses this boundary.
export interface OctomuxPlugin {
  apply(ctx: PluginContext): void | Promise<void>;
  /** REQUIRED for any plugin owning out-of-process state (worktrees, tmux, files
   *  written into a repo). Runs at boot after the DB is open. */
  reconcile?(ctx: PluginContext): Promise<void>;
}
export const PLUGIN_API_VERSION = 0;
```

`apply(ctx)` — never an imported registrar (WAVE-1/W1-A).

`reconcile(ctx)` — not `dispose()`. Octomux's units of composition are a git
worktree, a detached tmux server, and config written into someone else's repo.
None unwind on process exit; `kill -9` orphans all three.
`server/task-engine/reconcile.ts` (`recoverTasks`, `reconcileOrphanSettingUp`,
`gcScratchDirs`) is the existing, correct answer: probe the OS at boot, correct the
DB. Disposers stay only for registrations that can honour them — listeners,
registry rows, poller handles.

**Unload is not a goal.** Express 5 cannot unmount a router, and `server/api.ts`
documents a first-match-wins mount-order contract that load/unload would silently
break. The contract is enable/disable in the manifest + restart. Say so in the docs.

---

## THE BOOT-ORDER CONTRACT

_The single most important fact in this document. It is a correctness property with
a silent failure mode._

```
server/api.ts:47   for (const wf of listWorkflows()) if (wf.apiRouter) app.use(wf.apiRouter)
server/api.ts:69   mountCapabilityRoutes(app)  →  installCapabilities()   [sync, idempotent]
server/index.ts:51 acquireInstanceLock()
server/index.ts:53 createApp()      ← SYNC. Snapshots the workflow registry.
server/index.ts:77 recoverTasks()
```

`setupRoutes` **snapshots** the registry. Any registration after `createApp()` is a
silent no-op: a plugin workflow's router never mounts, a plugin capability never
reaches `mountCapabilityRoutes`.

> **`await loadPlugins(...)` goes between `server/index.ts:51` and `:53`. There is
> no second window. `createApp()` stays synchronous — ~40 supertest suites call it
> directly.**

`reconcile()` runs in the `:76`–`:79` band, **after** `recoverTasks()`, so a failing
plugin cannot stop octomux reconciling its own tmux sessions.

Get this right and no work package touches `server/api.ts`, `server/app.ts`, or
`server/registry/mount.ts` at all. Get it wrong and every package does.

**Corollary hazard:** if a plugin's `apply()` touches `ctx.kv` before `getDb()` has
otherwise been called, `initDb` now runs at plugin-load time — inside the try/catch
that WAVE-2 requires. A plugin could swallow a migration failure. Force `getDb()`
once before the loader runs.

---

## Non-goals (cut by review — do not reintroduce without a written trigger)

| Cut                                                  | Reason                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.isolation`                                      | Zero of three on the seam test: no definition, no second provider, no consumer boundary. Worktree+tmux is called concretely from `task-engine/launch.ts`, `terminals.ts`, `lifecycle/resume-task.ts`. It is also the only containment octomux has.                                             |
| Served third-party ESM in the dashboard              | `spec/workflow-framework.md` already lists it as a phase-1 non-goal. No CSP anywhere; `server/remote-auth.ts` returns `'allow'` unconditionally in local mode. dsh's own bundle _builder_ is unpublished — its worst external-author gap.                                                      |
| Per-plugin migrations / `ctx.storage` namespaces     | No schema version exists in octomux — zero hits for `user_version`/`schema_version`/`applied_migrations`. Plugins would become the only versioned thing in the DB. dsh's storage seam **refuses** migrations. Replaced by `plugin_kv`.                                                         |
| Event-sourced tasks ("UI-visible means logged")      | Octomux does not author its board facts — they arrive from a human dragging a card, `gh` reporting a merge, and `tmux has-session`. That is an observation log; replaying it reconstructs observations, not the world. `task_updates` is already append-only with a `task_id` FK and an index. |
| One unified `Plugin` descriptor                      | Four genuinely different shapes: `WorkflowType` carries an Express `Router`, `CapabilityMeta` a zod schema that must stay browser-importable, `Harness` builds commands, `IntegrationProvider` has `events`+`handler`. Unify the manifest row and the loader; keep the registries typed.       |
| Generated seam/config catalog                        | dsh generates ~9.5k lines of English catalogs (24k with translations) across 226 packages, each with its own `verify-*` CI gate. Octomux has 2 harnesses and 9 workflows. Trigger: 5 external plugins.                                                                                         |
| Embedded expressions in `octomux.yml` (dsh's `!!js`) | dsh's postmortem 0002: an uninterpolated `disabled: !!js …` was truthy and silently disabled its entire filesystem tool stack; every check passed. Config stays data.                                                                                                                          |
| `create-octomux-plugin` scaffolder                   | dsh has none either. A GitHub template repo does the same job for a fifth of the work.                                                                                                                                                                                                         |
| Unload / hot reload                                  | Express 5 cannot unmount. See the envelope.                                                                                                                                                                                                                                                    |

---

## Pinned interfaces

Four of seven `PluginContext` fields had no declared shape in the first draft, and
one was unimplementable as typed. Full set:

```ts
// packages/plugin-api/src/index.ts  — TYPES ONLY.
// CI assert: dist/index.js must be `export {};` or absent.

export interface PluginContext {
  readonly id: string; // manifest row id (bare, unqualified)
  readonly logger: PluginLogger;
  readonly settings: PluginSettingsScope;
  readonly kv: PluginKv;
  readonly workflows: WorkflowRegistrar;
  readonly integrations: IntegrationRegistrar;
  readonly harnesses: HarnessRegistrar;
}

// Structural minimum the host satisfies. NOT pino's Logger — a types-only package
// must not take a `pino` type dependency.
export interface PluginLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// ASYNC. getSettings() is Promise<OctomuxSettings> and dynamically imports
// harnesses/index.js. There is no sync full read.
export interface PluginSettingsScope {
  get<T = Record<string, unknown>>(): Promise<T>;
  update(patch: Record<string, unknown>): Promise<void>;
}

export interface PluginKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  del(key: string): void;
  list(prefix?: string): Array<{ key: string; value: unknown }>;
}

// All three qualify internally. The plugin declares a LOCAL id and never sees
// the qualified form.
export interface WorkflowRegistrar {
  register(wf: PluginWorkflow): void;
}
export interface IntegrationRegistrar {
  register(p: PluginIntegrationProvider): void;
}
export interface HarnessRegistrar {
  register(h: PluginHarness): void;
}

export interface PluginRow {
  id: string; // BARE local id, matches KIND_NAME_RE. Host qualifies.
  name: string; // npm package name OR absolute local path (dev loop)
  version?: string; // exact, not a range
  integrity?: string; // tarball hash; refuse to load on mismatch
  config?: Record<string, unknown>;
  disabled?: boolean;
}
export interface PluginManifest {
  plugins: PluginRow[];
}

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  resolvedPath: string;
  order: number;
  applyMs: number;
  reconcileMs?: number;
}
export interface LoadReport {
  loaded: LoadedPlugin[];
  failed: Array<{
    id: string;
    name: string;
    error: string;
    phase: 'resolve' | 'import' | 'apply' | 'reconcile';
  }>;
  manifestPath: string;
  safeMode: boolean;
}
```

```ts
// server/plugins/qualify.ts
export function qualify(pluginId: string, localId: string): string; // `${pluginId}:${localId}`

// server/plugins/loader.ts
export async function loadPlugins(opts: {
  manifestPath: string; // EXPLICIT. Never an implicit octomuxRoot() read.
  resolveFrom: string; // EXPLICIT. Default ~/.octomux/node_modules.
  resolve?: (name: string) => Promise<unknown>; // TEST SEAM — without it every
  // loader test is a fs fixture.
}): Promise<LoadReport>;

// server/settings.ts  (W3-C)
export interface OctomuxSettings {
  /* … */ plugins: Record<string, Record<string, unknown>>;
}
export function getPluginSettings(id: string): Promise<Record<string, unknown>>;
export function updatePluginSettings(
  id: string,
  patch: Record<string, unknown>,
): Promise<OctomuxSettings>;
```

### Two kind regexes, not one

```ts
KIND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/; // UNCHANGED. server/workflows/presets.ts.
// This is the path-traversal guard for
// PUT/DELETE /api/kinds/:kind, which writes
// into homeKindsDir(). Widening it to accept
// ':' or '/' reopens that hole.
QUALIFIED_KIND_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/; // registry keys ONLY,
// never a path component, never a filename.
```

A scoped package name is sanitized before qualification: `@foo/bar` → `foo-bar`.
The mapping is recorded in the manifest row so `plugins remove <pkg>` can reverse it.

### Registry guard asymmetry — write this in the file headers

```
registerHarness   → throws on redefinition   (currently last-write-wins)
registerProvider  → throws on redefinition   (currently last-write-wins)
registerWorkflow  → MUST NOT throw. server/workflows/presets.ts deliberately
                    re-registers existing kinds to overlay preset metadata, and
                    reloadPresets() runs again on every UI kind write. A duplicate
                    guard here breaks kind editing.
                    Plugin workflows go through registerPluginWorkflow(), which
                    rejects core ids and unqualified ids.
```

### Env vars, pinned so packages agree

`OCTOMUX_PLUGIN_MANIFEST`, `OCTOMUX_PLUGIN_PREFIX` (install root, default
`~/.octomux`), `OCTOMUX_PLUGINS_DIR` (kinds tier; mirrors the existing
`OCTOMUX_KINDS_DIR`), `OCTOMUX_SAFE_MODE`.

`octomuxRoot()` does **not** branch on `NODE_ENV` — only the DB dir does. Every one
of the above must be injectable or tests read the developer's real home. This is
the highest-volume flake source in the plan.

---

## Sole owners — declared once, honoured by every wave

| File                                      | Owner                    | Why                                                                                                                                         |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/index.ts`                        | W2-C, for the whole plan | Flat hand-written command registry. Six phases add commands. W2-C pre-registers `plugins`, `doctor`, `kind` as stubs; nobody else opens it. |
| `server/index.ts`, `bin/octomux.js`       | W2-C                     | Boot order is the correctness property.                                                                                                     |
| `server/settings.ts`                      | W3-C                     | ~14 test files `vi.mock` it; both read and write paths are allowlist literals.                                                              |
| `server/harnesses/types.ts`               | W3-B                     | 05a/05b/05c all add members; W3-B lands them all at once, then fans out.                                                                    |
| `server/task-engine/launch.ts`            | W4-B                     | 3 of 4 leaks plus the argv conversion; `buildAgentStartupCommand` is one 42-line function with a 625-line test file.                        |
| `server/repositories/tasks.ts`            | W4-D                     | 1178 lines; quiescence SQL and attribution setters both live here.                                                                          |
| `server/registry/route-inventory.test.ts` | integration pass only    | Bidirectional exact-equality assertion over **104** entries. Any package adding a route collides.                                           |
| root `package.json`                       | W1-A                     | `build` is a hand-ordered serial chain.                                                                                                     |

Note what is _not_ hot: `server/api.ts` needs no edits given the boot-order
contract, `server/db/schema.ts` is single-phase, `server/workflows/presets.ts` is
single-package, `server/registry/mount.ts` is untouched.

---

## WAVE-0 — restore installability (1.3.1 hotfix, blocks everything)

Not a plugin phase. A production fix.

- Rewrite `workspace:*` → exact versions at publish. Either publish with `npm`
  end-to-end or add a prepack step. **Verify with `npm pack` + inspection of the
  tarball manifest, not by trusting the tool.**
- Decide bundled-or-external per package and make tsup agree with `dependencies`:
  `@octomux/types` and `@octomux/diff-engine` → `noExternal`, move to
  `devDependencies`, publish separately for plugin authors. `@octomux/api-client`
  → real published dependency (`cli/dist` is tsc output, not bundled).
  `@octomux/test-fixtures` → drop from `dependencies` entirely.
- `@octomux/capabilities` is the real circularity: it is currently inlined into
  `dist-server`. The moment a plugin imports it, the plugin gets its own copy —
  different zod schema objects, different consts. Either mark it external, declare
  it, and publish it; or state that plugins may never import it. **Pick one and
  write it down.**
- `zod` is an undeclared runtime dependency (`packages/capabilities` imports it;
  it appears in the lockfile only transitively). Add it with a real range.
  Related: `build:server` bundles zod, so a plugin importing zod gets its own
  instance and `instanceof` checks fail across the boundary. Document it.
- **`npm pack` + install smoke test in `ci.yml`** — pack, install the tarball into
  a clean dir with real `npm` (not bun, not the workspace), boot
  `dist-server/index.js`, run `octomux --help`. One job, ~20 lines. It catches all
  of the above and every future dependency-graph regression, and would have caught
  all three broken releases.
- Matrix it: ubuntu + macos × node 20/24 (`engines` says ≥20, `publish.yml` builds
  on 24, `ci.yml` runs 20), with both `npm` and `bun` as install clients.

**Exit test:** the smoke job above, green, on a PR.

---

## WAVE-1 — five parallel packages, no plugin runtime yet

### W1-A — packaging, publish pipeline, `plugin-api` skeleton

**Files:** root `package.json` (`workspaces`, `files`, `build` chain), `tsconfig.json`,
`vitest.config.ts`, **new** `packages/plugin-api/{package.json,tsconfig.json,src/index.ts}`,
`packages/{types,capabilities,diff-engine,api-client}/package.json`,
**new** `.github/workflows/publish-packages.yml`.

- The publish set is **four packages, not two**: `@octomux/types` depends on
  `@octomux/diff-engine`, `@octomux/capabilities` peer-deps `@octomux/api-client`.
  Publish order: `diff-engine` → `types` → `api-client` → `capabilities`.
- Add `publishConfig.access: public` and `repository.directory` to each. The
  `packages/tmux-*` manifests already model this — copy them.
- Extend `publish.yml` using the idempotent pattern already in
  `build-binaries.yml` (`npm view "$PKG@$VER" && skip || npm publish --provenance`).
- Separate tag namespace (`pkg-v*`). octomux is 1.x; the plugin-facing packages
  move independently at **0.x** with an explicit "developer preview, breaking
  changes expected" notice. This only works if the server does **not** take a
  runtime dependency on the published copies — bundle types/diff-engine so
  breaking them cannot break an installed octomux.
- **Human blocker to flag in the PR:** OIDC trusted publishing is configured
  per-package on npmjs.com. Four manual steps outside this repo.

**Exit test:** `scripts/verify-publishable.test.ts` — for each publishable package
assert no `workspace:` in `dependencies`, `publishConfig.access === 'public'`, real
semver, and that `npm pack --dry-run --json` includes the type entrypoint. No
network, sub-second.

### W1-B — harness registration guards (additive only)

**Files:** `server/harnesses/{registry,index,claude-code,cursor}.ts` + their tests.

- `registerHarness` throws on redefinition; add `CORE_HARNESS_IDS` +
  `freezeCoreHarnesses()`. **Ship the throw as a `logger.warn` for one release**
  before it becomes fatal — a boot that hard-fails where it previously
  last-write-wins is an upgrade that reconciles nobody's tmux sessions.
- Both harnesses gain `export default`. **Keep the module-scope `registerHarness()`
  calls** — W2-A deletes them once the loader can replace them.

> **Correction to the first draft.** Core registration must _stay_ a side-effect
> import. The module-identity bug is about **plugins** importing a registrar, not
> about core. `server/settings.ts` dynamically imports `harnesses/index.js` on both
> the read and write paths; an empty `listHarnesses()` there silently disables
> harness-blob validation on read and throws `Unknown harness: claude-code` on
> write. Keeping core's side-effect import costs nothing and breaks nothing.

**Must NOT touch:** `server/settings.ts`, `server/plugins/**`.

### W1-C — integration + workflow registry guards

**Files:** `server/integrations/{registry,index}.ts`, `server/workflows/registry.ts`, + tests.

- `registerProvider` throws on redefinition + `CORE_PROVIDER_KINDS` freeze.
- `registerWorkflow` gets **no** guard; add `registerPluginWorkflow(qualifiedKind, wf)`.
  Write the asymmetry into the file header or someone deletes it in six months.

### W1-D — DB safety net + `plugin_kv`

**Files:** `server/db.ts`, `server/db/schema.ts`, `server/db/migrations.ts`,
**new** `server/repositories/plugin-kv.ts` + test, `server/repositories/index.ts`.

```sql
CREATE TABLE IF NOT EXISTS plugin_kv (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plugin_id, key)
) WITHOUT ROWID;
```

Appended to the `SCHEMA` template literal. `initDb` runs `exec(SCHEMA)` on every
open, so `IF NOT EXISTS` reaches existing DBs — zero contact with the 1,348-line
`migrations.ts`. (Against house habit: 25 of ~41 tables live only in `migrations.ts`.)

`VACUUM INTO` backup, with the constraints review forced:

- **In `getDb()`'s file-DB open path only — never in `initDb`/`runMigrations`.**
  132 test files call `createTestDb()`; a backup inside `runMigrations` writes a
  file per `beforeEach`.
- `chmodSync(backup, 0o600)` immediately. `VACUUM INTO` creates at default umask
  (0644) and the DB holds plaintext Jira/Linear/Slack tokens — that is why
  `db.ts` chmods the original.
- Timestamped filename, keep last 3, best-effort try/catch. An uncaught throw on
  "output file already exists" means `getDb()` fails and `recoverTasks()` never
  runs — the exact failure the safety net exists to prevent.
- Skip entirely for `:memory:`.

`user_version`: set it **write-only** — a recorded fact, never a control-flow
input. If anything ever reads it to _skip_ work, a DB stamped by a partially
completed run silently loses migrations. If nothing will read it, cut it; a hand-
bumped integer with no enforcement is a comment with extra steps.

Add `octomux doctor --restore <backup>`. That plus the backup is the only rollback
story octomux has at any layer — `renameAgentWorkerTables` is irreversible, and an
older binary recreates an empty `agents` table.

### W1-E — kinds as a third tier

**Files:** `server/workflows/presets.ts`, `server/octomux-paths.ts`,
`server/routes/kinds.ts`, + tests.

- `pluginKindsDir()` beside `builtInKindsDir()`/`homeKindsDir()`; scan order
  built-in → plugin → home. Needs `OCTOMUX_PLUGINS_DIR` or the phase is untestable.
- **Do not widen `KIND_NAME_RE`** — see the two-regex rule above.
- `checkPresetShape` requires `p.kind === <filename stem>`. A plugin ships
  `kinds/changelog.json` with `"kind": "changelog"`; the loader qualifies to
  `<pkg>:changelog` **after** validation. The author never writes the package name
  into the file.
- Because kinds are qualified they can never collide with a built-in, so there is
  no precedence question to answer.

**This package needs no loader.** It ships a real, installable, UI-bearing
third-party plugin on its own — config form, cron trigger, run row, detail page,
zero server or UI code from the author. Publish one worked example
(`octomux-kind-changelog`) plus ten example kinds and an `awesome-octomux-kinds`
repo. That is the demand experiment, and it is ~15% of this plan.

**Exit test:** a `plugin tier` describe block in `presets.test.ts` mirroring the
existing `home tier` block — registration, qualification, precedence, bad-file skip,
traversal-shaped name rejected, cannot shadow a built-in. Plus a jsdom test that a
qualified kind with a `config` schema renders its fields.

---

## WAVE-2 — the loader spine (three parallel packages)

### W2-A — manifest + loader core

**Files:** **new** `server/plugins/{manifest,loader}.ts` + tests;
`server/harnesses/{claude-code,cursor,index}.ts` (delete the two module-scope
`registerHarness` calls only).

- `NODE_ENV=test` ⇒ empty manifest, no filesystem read at all.
- Per-plugin `try/catch` + injectable timeout (never a wall-clock assertion in
  tests — use fake timers). Failure ⇒ `LoadReport.failed` + `logger.warn`, never a
  throw. Mirror the policy `presets.ts` already implements and documents.
- Core-first, freeze, then plugins. Every plugin registration qualified.
- Ship the `resolve` test seam. Without it every guard test becomes a filesystem
  fixture and the wave lands with ~0 unit coverage.

### W2-B — plugin context

**Files:** **new** `server/plugins/{context,qualify}.ts` + tests.

`ctx.logger = childLogger('plugin:' + id)`, pre-bound — plugins get no other
logging path. `ctx.kv` binds `plugin_id` onto W1-D's repo; never hand out the
`better-sqlite3` handle (it carries `loadExtension`, `ATTACH`, and every plaintext
credential). Assert the surface: every value on `ctx.kv` is a function and none is
a `Database`.

### W2-C — boot wiring, safe mode, CLI surface

**Files:** `server/index.ts`, `bin/octomux.js`, `cli/src/index.ts`,
**new** `cli/src/commands/{plugins,doctor,kind}.ts` + tests, `server/test-helpers.ts`.

- `await loadPlugins(...)` between `index.ts:51` and `:53`. Boot proceeds on a
  failed load.
- `bin/octomux.js` flag loop: `--safe-mode` → `OCTOMUX_SAFE_MODE=1`. Safe mode
  disables plugin rows only — core harnesses and providers still register, or
  `getHarness('claude-code')` throws everywhere.
- Owns `cli/src/index.ts` for the whole plan; registers all three commands up front.
- `octomux plugins disable <id>` **edits the manifest without booting the server**.
  The CLI is otherwise a pure HTTP client, so this needs new filesystem machinery —
  and `octomux doctor` needs the loader to persist its report to disk, or it is
  useless in exactly the case it exists for.
- `createTestHost({ plugins: [] })` taking **objects**, not package names. Scoped
  to the ~7 new plugin tests, not sprayed across 132 DB tests.

**Exit test (integration pass):** `scripts/smoke-external-plugin.mjs` after
`bun run build` — a **zero-dependency** fixture package, `npm pack`, install with
`--ignore-scripts` into a tmpdir, spawn `node dist-server/index.js` with
`OCTOMUX_DATA_DIR` under `os.tmpdir()` (assert this before spawning — `PROD_DB_DIR`
is computed at module load) and `--safe-mode`-adjacent background work disabled,
poll health, assert the plugin is listed, SIGTERM, clean up. ~45–70s.

> `ci.yml` runs `test` **before** `build` and has no Playwright step, so
> "green against the built artifact" has nowhere to live today. Reorder or add the
> job explicitly, or the phrase is decorative.

---

## WAVE-3 — capability seams (three parallel packages)

### W3-A — integration provider seam

**Files:** `server/integrations/index.ts`, `server/integrations/http-client.ts`,
`server/hook-dispatcher.ts`, `cli/src/commands/kind.ts` (fills W2-C's stub), + tests.

Replace the four side-effect imports with loader-driven registration. Note the
dispatcher lazily imports the _registry_, not the index — it relies on `api.ts`
having triggered registration. Move the four to manifest rows without the boot-order
contract and `getProvider()` returns `undefined`, and the dispatcher **silently
drops the event** with no log.

**Outbound broker.** `hook-dispatcher.ts` passes `resolveEnvVars(integration.config)`
— the resolved secret — straight to `provider.handler`, and `mask.ts` is
presentation-only. Route plugin providers through `HttpIntegrationClient`, which
holds `authHeaders` as a private field and never returns it.

> This contradicts "`IntegrationProvider` is unchanged". Resolve it explicitly:
> `configSchema` needs a declarative auth spec (it only has `secret: true` today,
> used for masking), and `IntegrationProvider` needs either a second handler
> signature `handler(envelope, config, http)` or a `trusted: boolean` discriminant.
> **Decide this before W3-A starts.**

**Exit test:** a plugin provider's handler never receives a resolved secret —
capture its args, assert the token string is absent. That one test is worth the
whole package.

### W3-B — harness contract surface (pulled forward from PHASE-05)

**Files:** `server/harnesses/types.ts` + test. ~40 lines.

```ts
readonly supportsClaudePlugins?: boolean;
buildPromptDelivery?(baseCmd: string, promptFile: string): string;
attachMcp?(flags: string, worktreePath: string, configPath: string): string;
sendMessage?(target: string, text: string): Promise<void>;
detectActivity?(target: string): Promise<'active' | 'idle'>;
// syncAgents REMOVED — an empty no-op in both harnesses. Do not publish a
// commitment to nothing.
```

All optional, current behaviour as the default. **Biggest single scheduling win in
the plan** — landing the interface early collapses 05a/05b/05c from serial to four
parallel packages.

### W3-C — `settings.plugins[id]` (sole owner of `server/settings.ts`)

Add `plugins` to `OctomuxSettings` **and to both allowlist literals** — the read
return and the update merge.

> **Correction to the first draft.** "Unknown ids preserved verbatim" is true only
> of `harnesses`, via an explicit branch. `updateSettings` builds an allowlist
> literal; any top-level key not named there is destroyed on the next write.

Delete dead `resolveClaudeFlags` while sole owner. Free.

---

## WAVE-4 — harness leaks (four parallel, after W3-B)

The first draft's leak table had four rows. The tree has ten, across **two
launchers** — the interactive worker path and a complete parallel headless path in
`server/agent-session/`.

| Pkg  | Files                                                                                                                     | Owns                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4-A | `server/octomux-plugin.ts`, `server/harness-flags.ts` + tests                                                             | `--plugin-dir` gating. **`appendOctomuxPluginFlags` is at `server/octomux-plugin.ts`, not `harness-flags.ts`** (12 lines, one function).                         |
| W4-B | `server/task-engine/launch.ts` + test (625 lines), `server/chats.ts`                                                      | `buildPromptDelivery` + `attachMcp`. `chats.ts` duplicates the `.claude-prompt-<id>` trick — fix both or the seam is fake.                                       |
| W4-C | `server/tmux-input.ts` + test                                                                                             | `sendMessage`. 45 lines, 6 callers unchanged. `server/orchestrator/runner.ts` has its own hardened send-keys path with capture-pane confirm — leave it, note it. |
| W4-D | `server/poller/quiescence.ts`, `server/poller/terminal-activity.ts`, `server/repositories/tasks.ts` (quiescence SQL only) | `detectActivity`. **The gate is SQL in `repositories/tasks.ts` (`listTasksAwaitingQuiescence`), not `quiescence.ts`**, which only post-filters.                  |

**Second launcher, unlisted in the first draft:** `server/agent-session/session.ts`
does its own `appendOctomuxPluginFlags('--dangerously-skip-permissions …')` and
`${baseCmd} --print < promptFile`, bypassing both `harness-flags.ts` and
`launch.ts`. `server/agent-session/mcp/config.ts` is a second MCP-config writer.
Also unlisted: `writeAgentLocalSettings` in `launch.ts` writes
`.claude/settings.local.json` into every new worktree with a Claude-plugin denylist,
and `harnesses/shared.ts` carries literal `claude --agent` verbs. **Size W4 for ten
leaks and two launchers.**

### W4-D needs a real design — the proposed fallback does not work

`buildAgentStartupCommand` launches `$SHELL -ic '<harness>; exec $SHELL -i'`, so
`pane_current_command` is the harness binary **while it sits at a prompt waiting for
a human**. The heuristic flips to idle only when the harness _exits_ — and an exited
harness is a stopped worker, which the quiescence gate excludes. It detects process
death, not idleness. `terminal-activity.ts` also writes `user_terminals.status`, not
`workers.hook_activity` — different table, different repository, so "generalize that
loop" is a rewrite.

The column confirms it: `workers.hook_activity` is `NOT NULL DEFAULT 'active'`, and
`'idle'` is written from exactly **one** place in the codebase — the Stop-hook route
in `server/hooks.ts`. A harness that does not POST that endpoint never quiesces, by
construction.

Options, none free: (a) require third-party harnesses to POST the existing hook
endpoints and document the schema — turns `detectActivity` into "publish the hook
contract"; (b) poll `pane_current_command` **plus** pane output stability over N
intervals; (c) accept that hookless harnesses need an explicit
`octomux task done` call. **Pick one before W4-D starts.** `terminal-activity.ts`
has no test file at all today.

---

## WAVE-5 — argv conversion (sequential)

**W5-A** — `server/harnesses/{shared,claude-code,cursor}.ts`, `server/hook-settings.ts`:
honour the new optionals; move `ALLOWED_TOOLS`/`DENIED_TOOLS` into the published
package (otherwise `installHooks` is unimplementable externally); promote cursor's
cross-read of `harnesses['claude-code'].dangerouslySkipPermissions` to an explicit
call argument.

**W5-B** — `buildLaunchCommand(): string[]`. Ripples through `harnesses/types.ts`,
`shared.ts`, both harnesses, `task-engine/launch.ts`, and
**`server/agent-session/substrate-tmux-windowed.ts`** — `launchAgentWindow` is a thin
delegate whose contract is `startupCmd: string`. Unlisted in the first draft.

This is the security-critical one: today a harness returns a shell string that
`launch.ts` runs as `$SHELL -ic '…'`, and `spec/harness-abstraction.md` assigns
injection validation **to the harness** — so publishing the interface moves that
obligation to a stranger. argv deletes the class rather than delegating it.

Also: existing worktrees keep the permission baseline written at creation. Moving
`ALLOWED_TOOLS` changes it for new tasks only, so a resumed task runs yesterday's
permissions and nobody can tell which. Rewrite on resume, or state the behaviour.

---

## The acceptance test — and why it cannot pass as first written

Extract `server/harnesses/cursor.ts` (273 lines, ~300 lines of tests), publish it as
`octomux-harness-cursor`, load it from `node_modules` through the loader against the
**built** artifact.

`cursor.ts`'s `installHooks` locates `bin/octomux-hook-bridge.js` by walking up six
directories from its own module and **throws** if it can't find it. From
`~/.octomux/node_modules/octomux-harness-cursor/dist/`, six levels up is the user's
home. `cursor.test.ts` already stubs that file into existence in `beforeAll` — the
suite is papering over exactly the coupling that makes extraction impossible.

**Fix first, in W5-A:** the host passes `bridgePath` into `installHooks(opts)`.
Then add `server/harnesses/contract.test.ts` running _every_ harness in
`listHarnesses()` through one table — builds a launch command, `installHooks` works
from a cwd **outside the repo**, declares `supportsClaudePlugins`, has
`detectActivity` or is covered by the fallback. The cwd-independence case is the one
that fails today.

Only then is the extraction mechanical.

---

## Trust model — state it, don't pretend otherwise

A plugin runs **in-process** with the DB handle, every credential, and
`process.env`. There is no in-process boundary and there will not be one. One line
mutating `OCTOMUX_CAPABILITY_GATE_ENABLED` in `apply()` disables every human
approval gate — `capabilityGateEnabled()` reads the env per call, not at boot.
(Mechanism, precisely: `gate.ts` runs inside the MCP stdio _subprocess_, so a
mutation at `apply()` time reaches every subprocess spawned afterwards. Since
plugins load before any task launches, that is all of them.)

dsh has no plugin trust boundary either; its own dynamic-plugin sandbox says "is not
containment: host-realm helper functions remain an escape route". There is no design
to copy. What must exist instead:

- One paragraph in the README, and an install-time consent prompt.
- `octomux start --safe-mode` as the kill switch.
- Install hygiene: `--ignore-scripts` enforced by octomux, not the user's npm
  config; an isolated prefix; exact `version` + `integrity` in the manifest row,
  refuse to load on mismatch; full package names only.
  > Correction: the first draft said there is no runtime `npm install` today.
  > There are two — `bin/octomux.js` and `scripts/postinstall.sh` — and both
  > already degrade with a warning. Also, the `@octomux/tmux-*` hijack vector is
  > not at the path first named: `tmux-bin.ts` resolves from `import.meta.url`, so
  > a package in `~/.octomux/node_modules` cannot hijack it. The real vector is the
  > global `lib/node_modules` sibling.
- Attribution is the only control that survives an in-process model. Emit an event
  row from the named setters in `server/repositories/tasks.ts` and widen
  `TASK_EVENT_TYPES`.

  > Note the shape of the work: of the 29 non-test `UPDATE tasks` statements, 21
  > live in `repositories/tasks.ts` but only **one** (`updateTaskFields`) consults
  > `TASK_WRITABLE_COLUMNS`. The other 20 are hand-written SQL that bypasses it.
  > They are still the right choke point — but there is no single allowlist hook
  > to bolt onto, so it is 20 call sites, not one.

  **Caveat:** membership in `TASK_EVENT_TYPES` is what makes an event persist with
  a `seq` and reach `supervisor.processEvent()`, so widening it changes
  orchestrator behaviour, not just the audit trail. Budget for that, not
  "~50 lines". Keep the mutable columns.

If `ctx.capabilities` is ever opened: plugin capabilities may not self-declare
`tier` below `ask` (`resolveTier` is raise-only from the declared tier, so `auto`
means the gate never runs); may not include `'agent'`/`'worker'` in `callers`
without an install-time grant; and `HttpProjection.auth` needs a
`'dashboard-session'` member — its only value today accepts _any_ live worker's
token cross-task.

### `route-inventory.test.ts` will go quietly green

The empty-test-manifest rule is right for determinism and wrong for coverage: the
repo's only complete-surface guarantee becomes blind to exactly the routes this plan
enables. `PENDING_MIGRATION` keeps shrinking, the test keeps passing, and plugin
routes have no drift test at all.

Fix before WAVE-1: tag ownership at registration (`owner: 'core' | '<plugin-id>'`,
set by the host, not self-declared) and split the assertion. `PENDING_MIGRATION`
stays exact-bidirectional over **core-owned** routes — that is the shrink-only
property worth keeping. Plugin routes get a separate rule: every plugin-owned route
must be a declared capability with a non-`bearer-hook-token` auth. No pending list,
no exceptions, because there is no legacy backlog for code that doesn't exist yet.

---

## Electron — plugins are CLI-only

`electron-builder.yml`'s `files:` list is `dist/**`, `dist-server/**`,
`dist-electron/**`, `node_modules/**`, `package.json`. electron-builder **replaces**
the default patterns rather than extending them, so `plugin/`, `kinds/`,
`templates/`, `workflows/`, `bin/`, and `scripts/` are not in the app bundle.

If that reading is right, the packaged app is already broken before any plugin work:
`bundledOctomuxPluginDir()` walks up six levels for `plugin/.claude-plugin/plugin.json`
and **throws**, and it is called unconditionally from `appendOctomuxPluginFlags` on
every task launch. `builtInKindsDir()` would resolve into `app.asar` and find
nothing. **Confirm against a real `.dmg` before believing it — but the config says
what it says, and if true it is a second P0 alongside WAVE-0.**

For plugins specifically: `octomuxRoot()` honours `OCTOMUX_DATA_DIR`, so the install
location is correct and per-app. But `npm` is not guaranteed to exist for a `.dmg`
user, and any plugin with a native module cannot work at all — Electron's ABI differs
from Node's and `@electron/rebuild` runs at package time on the maintainer's runner,
not at plugin-install time on the user's machine.

**Release position: plugins are a CLI-only feature. The Electron app boots with an
empty manifest and no install UI.** State it in the docs. Anything else promises a
channel that cannot be delivered.

---

## Critical path

```
WAVE-0 (installability)
  → W1-A packaging ─┐
  → W1-B/C/D/E ─────┼─ parallel
  → W2-A/B/C loader ┘
  → W3-A integrations · W3-B harness surface · W3-C settings   (parallel)
  → W4-A/B/C/D leaks                                            (parallel, needs W3-B)
  → W5-A/B argv                                                 (sequential)
  → acceptance test
```

Four items were pulled off the serial chain: the kinds tier (needs no loader),
the harness interface surface (~40 lines, fans out four packages), `plugin_kv` +
the DB safety net, and `detectActivity`. That takes the chain from ten serial links
to six.

**W1-E alone answers the demand question.** If waves 2–5 slip a quarter waiting for
that evidence, nothing breaks.

## Integration passes

One after each wave, orchestrator-run, sequential: `bun run typecheck` (owns
cross-package seam fixes) → full `bun run test` → reconcile
`server/registry/route-inventory.test.ts` for the whole wave → `lint:fix && format`.
After WAVE-2 and WAVE-5 only: the built-artifact smoke test.

## Execution rules

- Edit only the files listed for your package. Do not commit, do not run repo-wide
  `typecheck` — the integration pass owns those.
- Run only your own test files. Do not edit `server/test-helpers.ts` or
  `src/test-helpers.tsx` unless you own them; keep fixtures local.
- Honour the sole-owner table. Honour the boot-order contract.
- Repo conventions: pino `childLogger`, template-literal SQL with `datetime('now')`,
  table-driven `it.each`, Prettier (single quotes, trailing commas, 100 cols).
- No AI attribution in commits or PRs.

## Open decisions — settle before the wave that needs them

| Decision                                                                                                            | Blocks        |
| ------------------------------------------------------------------------------------------------------------------- | ------------- |
| `@octomux/capabilities`: external+published, or bundled and off-limits to plugins?                                  | WAVE-0        |
| Does the read-side of `IntegrationProvider` change (`handler(envelope, config, http)` vs a `trusted` discriminant)? | W3-A          |
| Which `detectActivity` design — publish the hook contract, output-stability polling, or explicit `task done`?       | W4-D          |
| Does anything read `user_version`? If not, cut it.                                                                  | W1-D          |
| Electron `files:` — confirm against a real `.dmg`.                                                                  | release scope |
