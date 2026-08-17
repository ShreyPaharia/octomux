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
import path from 'path';
import { childLogger } from '../logger.js';
import { readManifest } from './manifest.js';
import { manifestPath as defaultManifestPath } from './paths.js';
import { createPluginContext, revokePluginContext } from './context.js';
import type { LoadReport, LoadedPlugin, PluginContext } from '@octomux/plugin-api';

const logger = childLogger('plugins/loader');

const DEFAULT_APPLY_TIMEOUT_MS = 10_000;

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
  let order = 0;

  for (const row of manifest.manifest.plugins) {
    if (row.disabled) {
      logger.info({ id: row.id, name: row.name }, 'plugin disabled — skipped');
      continue;
    }

    let resolvedPath: string;
    try {
      resolvedPath = await resolve(row.name);
    } catch (err) {
      logger.warn({ id: row.id, name: row.name, err }, 'plugin resolve failed');
      failed.push({ id: row.id, name: row.name, error: errorMessage(err), phase: 'resolve' });
      continue;
    }

    // Reject bare-name resolutions that escaped the plugin prefix.
    // `createRequire` walks up the directory tree, so a package not actually
    // installed under `resolveFrom` (`pluginModulesDir()`) can still resolve
    // from `~/node_modules` or `/node_modules` — an unmanaged location — and
    // silently report `loaded`. Absolute-path rows (the documented dev loop)
    // are intentionally outside the prefix, so only bare-name resolutions are
    // checked.
    if (!path.isAbsolute(row.name)) {
      const rel = path.relative(opts.resolveFrom, resolvedPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        const message = `resolved path "${resolvedPath}" escapes the plugin prefix "${opts.resolveFrom}"`;
        logger.warn({ id: row.id, name: row.name, resolvedPath }, message);
        failed.push({ id: row.id, name: row.name, error: message, phase: 'resolve' });
        continue;
      }
    }

    let mod: Record<string, unknown>;
    try {
      // Timeout-wrapped like apply() below. Does NOT save you from a plugin
      // that blocks the event loop synchronously at import time, or calls
      // process.exit() — those still win regardless of any timeout here;
      // surviving that needs running the plugin in a worker, deliberately
      // out of scope for this loader.
      mod = await withTimeout(import(resolvedPath), applyTimeoutMs, `plugin "${row.id}" import`);
    } catch (err) {
      logger.warn({ id: row.id, name: row.name, resolvedPath, err }, 'plugin import failed');
      failed.push({ id: row.id, name: row.name, error: errorMessage(err), phase: 'import' });
      continue;
    }

    const apply = pluginApply(mod);
    if (!apply) {
      const message = `plugin module has no apply() export`;
      logger.warn({ id: row.id, name: row.name, resolvedPath }, message);
      failed.push({ id: row.id, name: row.name, error: message, phase: 'import' });
      continue;
    }

    // `start` is measured right here, not before resolve()/import() above —
    // `applyMs` on `LoadedPlugin` should mean what it says.
    const start = performance.now();
    const ctx = createPluginContext(row.id);
    try {
      await withTimeout(Promise.resolve(apply(ctx)), applyTimeoutMs, `plugin "${row.id}" apply()`);
    } catch (err) {
      // A timed-out apply() races on, uncancelled, in the background. Revoke
      // the context now so a late registration after the deadline can never
      // reach the live registries — a plugin reported `failed` must not be
      // able to silently install a harness/provider/workflow later.
      revokePluginContext(ctx);
      logger.warn({ id: row.id, name: row.name, err }, 'plugin apply() failed');
      failed.push({ id: row.id, name: row.name, error: errorMessage(err), phase: 'apply' });
      continue;
    }

    loaded.push({
      id: row.id,
      name: row.name,
      version: row.version ?? 'unknown',
      resolvedPath,
      order: order++,
      applyMs: performance.now() - start,
    });
  }

  return {
    loaded,
    failed,
    manifestPath: opts.manifestPath,
    safeMode,
    loadedAt: new Date().toISOString(),
  };
}
