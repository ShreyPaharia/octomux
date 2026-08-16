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
import { createPluginContext } from './context.js';
import type { LoadReport, LoadedPlugin, PluginContext, PluginRow } from '@octomux/plugin-api';

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
 * Races `promise` against an injectable timeout. Uses the ambient
 * `setTimeout`, deliberately — that's what lets a test's fake timers
 * (`vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync()`) trip it instead of
 * a real wall-clock sleep.
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
  /**
   * TEST SEAM. Defaults to the real `createPluginContext(row.id)`.
   *
   * Deliberately not a no-op stub: a context whose registrars silently do
   * nothing makes a plugin report as loaded while registering nothing, which
   * is the same "appears to persist, doesn't" failure `ctx.kv` throws to
   * avoid. Tests that want inertness inject it explicitly.
   */
  makeContext?: (row: PluginRow) => PluginContext;
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
  const empty = (): LoadReport => ({
    loaded: [],
    failed: [],
    manifestPath: opts.manifestPath,
    safeMode,
  });

  // Core registries must be frozen before any plugin row loads. Importing
  // these barrels is what performs the freeze — `freezeCoreHarnesses()` /
  // `freezeCoreProviders()` run as a module-scope side effect in
  // harnesses/index.ts / integrations/index.ts respectively, after their
  // core registrations. Both are idempotent (a `frozen` flag), so this is
  // safe to call again even if boot already imported them.
  await Promise.all([import('../harnesses/index.js'), import('../integrations/index.js')]);

  // "No explicit manifest" — the caller passed exactly the unconfigured
  // default (`paths.ts`'s `manifestPath()`, which falls back to the real
  // `~/.octomux/octomux.yml` unless `OCTOMUX_PLUGIN_MANIFEST` is set). Under
  // NODE_ENV=test, treat that as "nothing configured" and skip disk
  // entirely — the alternative is every test that forgets to override it
  // silently reading (or racing on) the developer's real home directory,
  // flagged as the plan's highest-volume flake source. A fixture manifest
  // path used by a real test never equals this, so it never trips the guard.
  if (process.env.NODE_ENV === 'test' && opts.manifestPath === defaultManifestPath()) {
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
      return readManifest(opts.manifestPath);
    } catch (err) {
      logger.warn(
        { err, manifestPath: opts.manifestPath },
        'plugin manifest unreadable — loading zero plugins',
      );
      return null;
    }
  })();
  if (manifest === null) return empty();

  const resolve = opts.resolve ?? ((name: string) => resolveViaAnchor(opts.resolveFrom, name));
  const makeContext = opts.makeContext ?? ((row: PluginRow) => createPluginContext(row.id));
  const applyTimeoutMs = opts.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;

  const loaded: LoadedPlugin[] = [];
  const failed: LoadReport['failed'] = [];
  let order = 0;

  for (const row of manifest.plugins) {
    if (row.disabled) {
      logger.info({ id: row.id, name: row.name }, 'plugin disabled — skipped');
      continue;
    }

    const start = performance.now();

    let resolvedPath: string;
    try {
      resolvedPath = await resolve(row.name);
    } catch (err) {
      logger.warn({ id: row.id, name: row.name, err }, 'plugin resolve failed');
      failed.push({ id: row.id, name: row.name, error: errorMessage(err), phase: 'resolve' });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = await import(resolvedPath);
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

    try {
      const ctx = makeContext(row);
      await withTimeout(Promise.resolve(apply(ctx)), applyTimeoutMs, `plugin "${row.id}" apply()`);
    } catch (err) {
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

  return { loaded, failed, manifestPath: opts.manifestPath, safeMode };
}
