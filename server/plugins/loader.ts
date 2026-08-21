/**
 * Loads installed plugins from the manifest. Per-plugin isolation only — this
 * file never throws; every failure becomes a `LoadReport.failed` row plus a
 * `logger.warn`, matching the policy `server/workflows/presets.ts` already
 * implements for malformed presets/manifests.
 *
 * Resolution (spike S1, plans/2026-08-16-plugin-ecosystem-tasks.md): an
 * absolute path is `import()`ed directly; a bare package name resolves via
 * `createRequire(<resolveFrom>/anchor.js).resolve(name)` first, then that
 * resolved path is `import()`ed. Never derive a disk path from the current
 * module's own URL/dirname — under `bun build --compile` that resolves into
 * the compiled binary's embedded virtual filesystem, not real disk (spike
 * S2). `server/plugins/paths.ts` already carries that constraint for every
 * path this module receives as input.
 *
 * `reconcile?(ctx)` is intentionally NOT called here — that is a later wave
 * (runs after `recoverTasks()` in the boot sequence; see the plan's
 * "boot-order contract"). This loader only calls `apply(ctx)`.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { broadcast } from '../events.js';
import { readManifest } from './manifest.js';
import { manifestPath as defaultManifestPath } from './paths.js';
import { createPluginContext } from './context.js';
import { unmountPlugin, getPluginUnloadability } from './lifecycle.js';
import { resolveGrantsForRow, allPluginGrants } from './grants.js';
import type { UnmountReport } from './lifecycle.js';
import type {
  LoadReport,
  LoadedPlugin,
  PluginContext,
  PluginRow,
  PluginCapability,
} from '@octomux/plugin-api';

const logger = childLogger('plugins/loader');

const DEFAULT_APPLY_TIMEOUT_MS = 10_000;

/** Runtime handle for one currently-mounted plugin — everything `unloadPlugin`/
 *  `reloadPlugin` need to tear it down or re-mount it. `mod` is the already-
 *  evaluated module object (kept alive by this reference) — `reloadPlugin`
 *  uses it to roll a failed reload back to the previously-working version
 *  without re-importing anything. */
export interface MountedPlugin {
  ctx: PluginContext;
  row: PluginRow;
  resolvedPath: string;
  mod: Record<string, unknown>;
}

/** pluginId -> live mount state, for every plugin currently applied and not
 *  yet unmounted. Populated by `loadPlugins()` at boot and by `reloadPlugin()`
 *  below; consumed by `unloadPlugin()`/`reloadPlugin()` and the (future) dev
 *  file watcher to find what to tear down before remounting. */
const mounted = new Map<string, MountedPlugin>();

/** Runtime state for a currently-mounted plugin, or `undefined` if it was
 *  never loaded, failed to load, or has already been unloaded. */
export function getMountedPlugin(id: string): MountedPlugin | undefined {
  return mounted.get(id);
}

/** Every currently-mounted plugin id. */
export function listMountedPluginIds(): string[] {
  return Array.from(mounted.keys());
}

/** Test-only: clears mount tracking without touching the live registries —
 *  pair with each registry's own `reset*()` for a full reset between tests. */
export function resetMountedPlugins(): void {
  mounted.clear();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSafeMode(): boolean {
  const v = process.env.OCTOMUX_SAFE_MODE;
  return v === '1' || v === 'true';
}

/**
 * The real resolution strategy (spike S1). `opts.resolve` overrides this
 * entirely in tests — this function is never exported, so a test cannot
 * accidentally call the real thing and hit disk by mistake.
 */
async function resolveViaAnchor(resolveFrom: string, name: string): Promise<string> {
  if (path.isAbsolute(name)) return name;
  const anchor = path.join(resolveFrom, 'anchor.js');
  return createRequire(anchor).resolve(name);
}

/**
 * Races `promise` against an injectable timeout, in milliseconds. The `ms`
 * parameter is what makes this testable — pass a small real timeout
 * (`applyTimeoutMs: 10`) rather than reaching for fake timers. Fake timers
 * (`vi.useFakeTimers()`) don't work here: `loadPlugins` awaits real async
 * work (a dynamic `import()`) before it ever reaches this `setTimeout`, so
 * `advanceTimersByTimeAsync` would resolve before the timer is even
 * scheduled, then hang forever on a timer that never fires.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface LoadPluginsOptions {
  /** Explicit manifest path — never computed implicitly by this function. */
  manifestPath: string;
  /** `pluginModulesDir()` — the resolution anchor (see S1). */
  resolveFrom: string;
  /** TEST SEAM. Defaults to the real S1 resolution (anchor.js + createRequire). */
  resolve?: (name: string) => Promise<string>;
  /** Injectable per-plugin `apply()` timeout, in ms. Default 10s. */
  applyTimeoutMs?: number;
}

/**
 * A plugin may export `apply` as a named export or hang it off a default
 * export (`export default { apply }`) — both read naturally as "this module
 * is the plugin", and picking one silently breaks the other for no reason.
 */
function pluginApply(mod: Record<string, unknown>): ((ctx: PluginContext) => unknown) | null {
  const direct = mod.apply;
  if (typeof direct === 'function') return direct as (ctx: PluginContext) => unknown;
  const fromDefault = (mod.default as Record<string, unknown> | undefined)?.apply;
  if (typeof fromDefault === 'function') return fromDefault as (ctx: PluginContext) => unknown;
  return null;
}

type LoadOneResult =
  | {
      ok: true;
      loaded: Omit<LoadedPlugin, 'order'>;
      ctx: PluginContext;
      resolvedPath: string;
      mod: Record<string, unknown>;
      /** Declared grants withheld this attempt (declared ⊄ acknowledged). */
      pending: PluginCapability[];
    }
  | { ok: false; failed: LoadReport['failed'][number]; pending: PluginCapability[] };

type ResolveImportResult =
  | { ok: true; mod: Record<string, unknown>; resolvedPath: string }
  | { ok: false; failed: LoadReport['failed'][number] };

/**
 * Resolves and imports ONE manifest row's module — split out from applying it
 * so `reloadPlugin()`'s rollback path can re-apply an already-resolved OLD
 * module without re-resolving/re-importing it. Never throws; failure becomes
 * the `{ ok: false }` branch, matching `loadPlugins()`'s per-row isolation
 * policy.
 *
 * `importPath` is a seam: `reloadPlugin()` passes a cache-busted specifier so
 * a dev edit to a local-path plugin's source is actually re-evaluated — the
 * ESM module cache is keyed on the exact resolved specifier, and importing
 * the same path a second time silently hands back the stale, already-
 * evaluated module.
 */
async function resolveAndImportRow(
  row: PluginRow,
  resolve: (name: string) => Promise<string>,
  resolveFrom: string,
  applyTimeoutMs: number,
  importPath: (resolvedPath: string) => Promise<Record<string, unknown>>,
): Promise<ResolveImportResult> {
  let resolvedPath: string;
  try {
    resolvedPath = await resolve(row.name);
  } catch (err) {
    logger.warn({ id: row.id, name: row.name, err }, 'plugin resolve failed');
    return {
      ok: false,
      failed: { id: row.id, name: row.name, error: errorMessage(err), phase: 'resolve' },
    };
  }

  // Reject bare-name resolutions that escaped the plugin prefix.
  // `createRequire` walks up the directory tree, so a package not actually
  // installed under `resolveFrom` (`pluginModulesDir()`) can still resolve
  // from `~/node_modules` or `/node_modules` — an unmanaged location — and
  // silently report `loaded`. Absolute-path rows (the documented dev loop)
  // are intentionally outside the prefix, so only bare-name resolutions are
  // checked.
  if (!path.isAbsolute(row.name)) {
    const rel = path.relative(resolveFrom, resolvedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const message = `resolved path "${resolvedPath}" escapes the plugin prefix "${resolveFrom}"`;
      logger.warn({ id: row.id, name: row.name, resolvedPath }, message);
      return {
        ok: false,
        failed: { id: row.id, name: row.name, error: message, phase: 'resolve' },
      };
    }
  }

  let mod: Record<string, unknown>;
  try {
    // Timeout-wrapped like apply() below. Does NOT save you from a plugin
    // that blocks the event loop synchronously at import time, or calls
    // process.exit() — those still win regardless of any timeout here;
    // surviving that needs running the plugin in a worker, deliberately
    // out of scope for this loader.
    mod = await withTimeout(importPath(resolvedPath), applyTimeoutMs, `plugin "${row.id}" import`);
  } catch (err) {
    logger.warn({ id: row.id, name: row.name, resolvedPath, err }, 'plugin import failed');
    return {
      ok: false,
      failed: { id: row.id, name: row.name, error: errorMessage(err), phase: 'import' },
    };
  }

  return { ok: true, mod, resolvedPath };
}

/**
 * Applies an already-resolved/imported module for a row — the second half of
 * what used to be `loadOneRow()`, split out so `reloadPlugin()`'s rollback
 * path can re-apply the OLD module (still in memory) against a fresh context
 * without touching disk again.
 *
 * On failure, unmounts whatever the plugin managed to register before it
 * threw/timed out (SHR-254 review finding: a partial `apply()` used to only
 * revoke the context, leaking every registration made before the throw and
 * wedging the next reload against "already registered"/"already defined").
 * `unmountPlugin` is safe to call here even though this plugin was never
 * added to `mounted` — every registry's `unregisterPlugin*` is a no-op-safe
 * delete, and `unmountPlugin` itself documents being safe when nothing was
 * released.
 */
async function applyResolvedModule(
  row: PluginRow,
  mod: Record<string, unknown>,
  resolvedPath: string,
  applyTimeoutMs: number,
  manifestPath: string,
): Promise<LoadOneResult> {
  const apply = pluginApply(mod);
  if (!apply) {
    const message = `plugin module has no apply() export`;
    logger.warn({ id: row.id, name: row.name, resolvedPath }, message);
    return {
      ok: false,
      failed: { id: row.id, name: row.name, error: message, phase: 'import' },
      pending: [],
    };
  }

  // Resolve grants against the ledger BEFORE creating the context — the
  // context is what enforces them (`assertGranted` inside each registrar),
  // so it must be built from the effective (possibly narrowed) set, never
  // the row's raw `declared` list. A widened grant that hasn't been
  // acknowledged via `octomux plugins approve <id>` is withheld this boot:
  // the plugin still loads with whatever it already had, but the un-granted
  // capability throws the moment it's actually used — see grants.ts's doc
  // comment for the full ledger semantics.
  const { effective, pending } = resolveGrantsForRow(manifestPath, row.id, row.grants);
  if (pending.length > 0) {
    logger.warn(
      { id: row.id, pending },
      'plugin declares capability grants that have not been acknowledged — withheld this boot; run: octomux plugins approve <id>',
    );
  }

  // `start` is measured right here, not before resolve()/import() above —
  // `applyMs` on `LoadedPlugin` should mean what it says.
  const start = performance.now();
  const ctx = createPluginContext(row.id, effective);
  try {
    await withTimeout(Promise.resolve(apply(ctx)), applyTimeoutMs, `plugin "${row.id}" apply()`);
  } catch (err) {
    // A timed-out apply() races on, uncancelled, in the background. Tear
    // down whatever it already registered AND revoke the context (via
    // unmountPlugin's own disposePluginContext step) so neither a late
    // registration after the deadline, nor a leftover registration from
    // before the throw, can survive a plugin reported `failed`.
    await unmountPlugin(row.id, ctx);
    logger.warn({ id: row.id, name: row.name, err }, 'plugin apply() failed');
    return {
      ok: false,
      failed: { id: row.id, name: row.name, error: errorMessage(err), phase: 'apply' },
      pending,
    };
  }

  // SHR-256: a successful mount changes what `GET /api/plugin-ui/contributions`
  // returns (this plugin may have contributed panels), so tell clients to
  // refetch. Covers every path that ends here: initial boot load, an
  // explicit reload, and reloadPlugin's rollback re-apply of the old module.
  broadcast({ type: 'plugin:ui-updated', payload: { pluginId: row.id } });

  return {
    ok: true,
    loaded: {
      id: row.id,
      name: row.name,
      version: row.version ?? 'unknown',
      resolvedPath,
      applyMs: performance.now() - start,
    },
    ctx,
    resolvedPath,
    mod,
    pending,
  };
}

/**
 * Resolves, imports, and applies ONE manifest row — the exact body
 * `loadPlugins()`'s boot loop runs per row, factored out so `reloadPlugin()`
 * can run the identical sequence for a single row without a whole-manifest
 * pass. Never throws; failure becomes the `{ ok: false }` branch.
 */
async function loadOneRow(
  row: PluginRow,
  resolve: (name: string) => Promise<string>,
  resolveFrom: string,
  applyTimeoutMs: number,
  manifestPath: string,
  importPath: (resolvedPath: string) => Promise<Record<string, unknown>> = (p) => import(p),
): Promise<LoadOneResult> {
  const resolved = await resolveAndImportRow(row, resolve, resolveFrom, applyTimeoutMs, importPath);
  if (!resolved.ok) return { ...resolved, pending: [] };
  return applyResolvedModule(
    row,
    resolved.mod,
    resolved.resolvedPath,
    applyTimeoutMs,
    manifestPath,
  );
}

/**
 * Loads every enabled row in the manifest, in order, isolating each in its
 * own try/catch. Never throws.
 */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadReport> {
  const safeMode = isSafeMode();
  const empty = (manifestError?: string): LoadReport => ({
    loaded: [],
    failed: [],
    manifestPath: opts.manifestPath,
    safeMode,
    ...(manifestError !== undefined ? { manifestError } : {}),
    loadedAt: new Date().toISOString(),
  });

  // Core registries must be frozen (harnesses/integrations barrels imported,
  // triggering their module-scope `freezeCore*()` calls) before any plugin
  // row loads. That already happens by the time this function runs: the only
  // production caller is `server/index.ts`, which statically imports
  // `app.js` (which statically imports both barrels) before it ever calls
  // `loadPlugins()`. ESM evaluates the whole static-import graph first, so
  // the freeze is guaranteed done. No dynamic re-import needed here.

  // "No explicit manifest" — the caller passed exactly the unconfigured
  // default (`paths.ts`'s `manifestPath()`, which falls back to the real
  // `~/.octomux/octomux.yml` unless `OCTOMUX_PLUGIN_MANIFEST` is set). Under
  // NODE_ENV=test, treat that as "nothing configured" and skip disk
  // entirely — the alternative is every test that forgets to override it
  // silently reading (or racing on) the developer's real home directory,
  // flagged as the plan's highest-volume flake source.
  //
  // The path-equality check alone is not sufficient: `defaultManifestPath()`
  // itself returns `OCTOMUX_PLUGIN_MANIFEST` when set, and stubbing that var
  // to point at a fixture is exactly this repo's convention for pointing
  // tests at a real manifest (`presets.test.ts`, `routes/kinds.test.ts`,
  // `cli/src/commands/plugins.test.ts`). A test that stubs the var and then
  // passes `defaultManifestPath()` through unchanged would have
  // `opts.manifestPath === defaultManifestPath()` trivially true, so the old
  // path-only check swallowed it. Require the var to be unset too, so an
  // explicit fixture manifest (however it was pointed at) is never skipped.
  if (
    process.env.NODE_ENV === 'test' &&
    opts.manifestPath === defaultManifestPath() &&
    !process.env.OCTOMUX_PLUGIN_MANIFEST
  ) {
    logger.debug(
      'NODE_ENV=test with the unconfigured default manifest path — skipping, no fs read',
    );
    return empty();
  }

  if (safeMode) {
    logger.warn(
      'OCTOMUX_SAFE_MODE active — skipping all plugin rows (core harnesses/providers unaffected)',
    );
    return empty();
  }

  const manifest = (() => {
    try {
      return { ok: true as const, manifest: readManifest(opts.manifestPath) };
    } catch (err) {
      logger.warn(
        { err, manifestPath: opts.manifestPath },
        'plugin manifest unreadable — loading zero plugins',
      );
      return { ok: false as const, error: errorMessage(err) };
    }
  })();
  if (!manifest.ok) return empty(manifest.error);

  const resolve = opts.resolve ?? ((name: string) => resolveViaAnchor(opts.resolveFrom, name));
  const applyTimeoutMs = opts.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;

  const loaded: LoadedPlugin[] = [];
  const failed: LoadReport['failed'] = [];
  const pendingGrants: Record<string, PluginCapability[]> = {};
  let order = 0;

  for (const row of manifest.manifest.plugins) {
    if (row.disabled) {
      logger.info({ id: row.id, name: row.name }, 'plugin disabled — skipped');
      continue;
    }

    const result = await loadOneRow(
      row,
      resolve,
      opts.resolveFrom,
      applyTimeoutMs,
      opts.manifestPath,
    );
    if (result.pending.length > 0) {
      pendingGrants[row.id] = result.pending;
    }
    if (!result.ok) {
      failed.push(result.failed);
      continue;
    }

    mounted.set(row.id, {
      ctx: result.ctx,
      row,
      resolvedPath: result.resolvedPath,
      mod: result.mod,
    });
    loaded.push({ ...result.loaded, order: order++ });
  }

  return {
    loaded,
    failed,
    manifestPath: opts.manifestPath,
    safeMode,
    loadedAt: new Date().toISOString(),
    // Every plugin's EFFECTIVE grants this boot, regardless of pending/failed
    // status — `allPluginGrants()` reads the same in-memory map the loader
    // just populated via `createPluginContext(id, effective)`.
    grants: allPluginGrants(),
    // Omitted entirely (not an empty object) when nothing is pending, so an
    // older report and a clean boot both read the same on this field.
    ...(Object.keys(pendingGrants).length > 0 ? { pendingGrants } : {}),
  };
}

export type UnloadResult = { ok: true; report: UnmountReport } | { ok: false; reason: string };

/**
 * Unmounts a currently-mounted plugin: runs `lifecycle.ts`'s reverse teardown
 * sequence and drops it from `mounted`. Refuses without touching anything if
 * the plugin isn't mounted, or if it declared `WorkflowType.apiRouter`
 * (`getPluginUnloadability` — express 5 cannot unmount a Router).
 */
export async function unloadPlugin(id: string): Promise<UnloadResult> {
  const entry = mounted.get(id);
  if (!entry) {
    return { ok: false, reason: `plugin "${id}" is not currently mounted` };
  }

  const unloadability = getPluginUnloadability(id);
  if (!unloadability.unloadable) {
    return { ok: false, reason: unloadability.reason ?? `plugin "${id}" cannot be unloaded` };
  }

  const report = await unmountPlugin(id, entry.ctx);
  mounted.delete(id);
  return { ok: true, report };
}

export interface ReloadPluginOptions {
  manifestPath: string;
  resolveFrom: string;
  id: string;
  /** TEST SEAM, same as `LoadPluginsOptions.resolve`. */
  resolve?: (name: string) => Promise<string>;
  applyTimeoutMs?: number;
}

export type ReloadResult =
  | { ok: true; loaded: LoadedPlugin }
  | {
      ok: false;
      reason: string;
      unloadable?: false;
      /**
       * Only meaningful when a previously-working mount existed and the new
       * version failed to apply (i.e. `unloadable` is not set): `true` means
       * the old version was successfully re-applied and is live again;
       * `false` means restoring it ALSO failed and the plugin is now fully
       * unmounted. `undefined` means there was nothing to restore (fresh
       * mount failure, or refusal before any teardown happened).
       */
      restored?: boolean;
    };

/**
 * The actual reload sequence for one plugin id — everything `reloadPlugin()`
 * does except serializing concurrent calls (see below). Split out so the
 * public `reloadPlugin()` can chain overlapping calls onto this rather than
 * running two of these concurrently for the same id.
 *
 * Unmounts the plugin if it's currently mounted, then mounts it fresh from
 * the manifest row's CURRENT on-disk code. Cache-busts the import (`?t=<epoch
 * ms>` query on the specifier) so a local-path row's edited source is
 * actually re-evaluated rather than served stale from the ESM module cache
 * (verified against bun's dynamic `import()` — a distinct query string is a
 * distinct module identity).
 *
 * Refuses (no unmount, no remount) if the row is missing/disabled in the
 * manifest, or if the currently-mounted instance is `unloadable: false`.
 *
 * Not atomic by nature (unmount, then a real import + apply happen in
 * between) — if the new version fails, the previously-mounted module
 * reference (captured before teardown) is re-applied against a fresh context
 * to restore the old working state rather than leaving the plugin dark. See
 * `ReloadResult.restored` for how that outcome is reported.
 */
async function reloadPluginOnce(opts: ReloadPluginOptions): Promise<ReloadResult> {
  let manifest;
  try {
    manifest = readManifest(opts.manifestPath);
  } catch (err) {
    return { ok: false, reason: `manifest unreadable: ${errorMessage(err)}` };
  }

  const row = manifest.plugins.find((r) => r.id === opts.id);
  if (!row) {
    return { ok: false, reason: `no plugin with id "${opts.id}" in the manifest` };
  }
  if (row.disabled) {
    return { ok: false, reason: `plugin "${opts.id}" is disabled in the manifest` };
  }

  // Captured BEFORE any teardown — `unloadPlugin` below deletes this same
  // entry from `mounted`, but the module object it references stays alive as
  // long as we hold this reference, so a failed reload can still re-apply it.
  const previous = mounted.get(opts.id);

  if (previous) {
    const unloaded = await unloadPlugin(opts.id);
    if (!unloaded.ok) {
      return { ok: false, reason: unloaded.reason, unloadable: false };
    }
  }

  const resolve = opts.resolve ?? ((name: string) => resolveViaAnchor(opts.resolveFrom, name));
  const applyTimeoutMs = opts.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  const cacheBust = Date.now();
  const result = await loadOneRow(
    row,
    resolve,
    opts.resolveFrom,
    applyTimeoutMs,
    opts.manifestPath,
    (p) => import(`${p}?t=${cacheBust}`),
  );
  if (result.ok) {
    mounted.set(row.id, {
      ctx: result.ctx,
      row,
      resolvedPath: result.resolvedPath,
      mod: result.mod,
    });
    return { ok: true, loaded: { ...result.loaded, order: 0 } };
  }

  // New version failed. Nothing was previously mounted (a fresh-install
  // failure, or the row itself never applied before) — there is nothing to
  // roll back to.
  if (!previous) {
    return { ok: false, reason: result.failed.error };
  }

  // Restore the previously-working version from the module reference we
  // captured before unmounting it — no re-import, just re-running its
  // apply() against a brand new context.
  // Grants are re-resolved from `previous.row` (the OLD row, still whatever
  // was in the manifest before this reload attempt) rather than carried over
  // from the failed new attempt — the ledger call is idempotent (narrowing/
  // unchanged re-records freely) so this is safe to call again.
  const restore = await applyResolvedModule(
    previous.row,
    previous.mod,
    previous.resolvedPath,
    applyTimeoutMs,
    opts.manifestPath,
  );
  if (restore.ok) {
    mounted.set(opts.id, {
      ctx: restore.ctx,
      row: previous.row,
      resolvedPath: previous.resolvedPath,
      mod: previous.mod,
    });
    logger.warn(
      { id: opts.id, error: result.failed.error },
      'plugin reload failed — restored the previously-working version',
    );
    return { ok: false, reason: result.failed.error, restored: true };
  }

  // The restore attempt ALSO failed (e.g. the old apply() isn't idempotent
  // and can't safely run twice). Nothing is mounted now — say so plainly
  // rather than pretending a rollback happened.
  logger.warn(
    { id: opts.id, reloadError: result.failed.error, restoreError: restore.failed.error },
    'plugin reload failed and the previous version could not be restored — plugin is now unmounted',
  );
  return { ok: false, reason: result.failed.error, restored: false };
}

/** In-flight `reloadPluginOnce()` calls, keyed by plugin id — see
 *  `reloadPlugin()`'s doc comment. */
const inFlightReloads = new Map<string, Promise<ReloadResult>>();

/**
 * `octomux plugins reload <id>` (and the dev file watcher) call this.
 *
 * Serializes reloads per plugin id. The dev file watcher debounces per id
 * (~300ms), but a save landing after a debounced reload has already started
 * — and before it resolves — would otherwise fire a second, CONCURRENT
 * `reloadPluginOnce()` for the same id, both racing `mounted.has()` /
 * `unloadPlugin()` / `mounted.set()` against each other. Chain a new request
 * onto whatever is already in flight for that id instead of running them
 * concurrently. The map entry is removed once the chained call settles, so
 * it never grows past the number of ids currently mid-reload.
 */
export function reloadPlugin(opts: ReloadPluginOptions): Promise<ReloadResult> {
  const prior = inFlightReloads.get(opts.id) ?? Promise.resolve();
  const chained = prior.then(
    () => reloadPluginOnce(opts),
    () => reloadPluginOnce(opts),
  );
  inFlightReloads.set(opts.id, chained);
  chained.finally(() => {
    if (inFlightReloads.get(opts.id) === chained) {
      inFlightReloads.delete(opts.id);
    }
  });
  return chained;
}

export interface WatchLocalPluginsOptions {
  manifestPath: string;
  resolveFrom: string;
  /** Debounce window per plugin id, coalescing a save's burst of fs events
   *  into one reload. Default 300ms. */
  debounceMs?: number;
}

/**
 * DEV ONLY (caller must gate on `NODE_ENV !== 'production'` — this function
 * does not check it itself, so tests can exercise it directly). Watches every
 * enabled LOCAL-PATH manifest row's directory (the documented dev loop — an
 * absolute `row.name`, never an installed npm package) and calls
 * `reloadPlugin()` on a debounced change.
 *
 * Best-effort: `fs.watch`'s `recursive: true` is unsupported on Linux (Node/
 * Bun both silently ignore it there), so a save in a nested directory won't
 * trigger a reload on that platform — the same ceiling every `fs.watch`-based
 * dev tool has. A row whose directory can't be watched (already deleted,
 * permissions) is logged and skipped, never a crash.
 *
 * Returns a stop function that closes every watcher and cancels any pending
 * debounce timer.
 */
export function watchLocalPlugins(opts: WatchLocalPluginsOptions): () => void {
  const debounceMs = opts.debounceMs ?? 300;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: fs.FSWatcher[] = [];

  let manifest;
  try {
    manifest = readManifest(opts.manifestPath);
  } catch (err) {
    logger.warn({ err }, 'plugin watcher: manifest unreadable — watching nothing');
    return () => {};
  }

  const triggerReload = (id: string) => {
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        reloadPlugin({ manifestPath: opts.manifestPath, resolveFrom: opts.resolveFrom, id })
          .then((result) => {
            if (result.ok) {
              logger.info({ id }, 'plugin watcher: reloaded on save');
            } else {
              logger.warn({ id, reason: result.reason }, 'plugin watcher: reload failed');
            }
          })
          .catch((err) => logger.warn({ id, err }, 'plugin watcher: reload threw'));
      }, debounceMs),
    );
  };

  for (const row of manifest.plugins) {
    if (row.disabled || !path.isAbsolute(row.name)) continue;
    try {
      const watcher = fs.watch(row.name, { recursive: true }, () => triggerReload(row.id));
      watchers.push(watcher);
    } catch (err) {
      logger.warn({ id: row.id, path: row.name, err }, 'plugin watcher: failed to watch directory');
    }
  }

  logger.info({ watching: watchers.length }, 'plugin watcher: started (dev only)');

  return () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
