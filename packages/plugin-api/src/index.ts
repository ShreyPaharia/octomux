/**
 * @octomux/plugin-api — TYPES ONLY. Nothing runtime crosses this boundary.
 *
 * CI assert: dist/index.js must be `export {};` or absent, apart from the
 * `PLUGIN_API_VERSION` const below. See `plans/2026-08-16-plugin-ecosystem.md`
 * ("The envelope" / "Pinned interfaces") — this file is a verbatim copy of
 * the pinned shapes plus the two runtime-facing exports the plan reserves
 * for this package (`PLUGIN_API_VERSION`, `OctomuxPlugin`).
 */

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

// Registrar payload shapes are intentionally loose here — the plan leaves the
// concrete `WorkflowType` / `IntegrationProvider` / `Harness` bindings to the
// server-side registries (WAVE-2/WAVE-3), which are not browser- or
// plugin-facing. A types-only package must not import them.
export type PluginWorkflow = Record<string, unknown>;
export type PluginIntegrationProvider = Record<string, unknown>;
export type PluginHarness = Record<string, unknown>;

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
  /** Set when the manifest itself failed to read/parse — distinguishes "zero
   *  plugins configured" from "boot couldn't even read the manifest". */
  manifestError?: string;
  /** ISO timestamp of when this report was produced, so a stale report from a
   *  boot that died doesn't read as current. Optional so existing/synthetic
   *  `LoadReport` literals (older persisted reports, fixtures) stay valid —
   *  `loadPlugins()` itself always sets it. */
  loadedAt?: string;
}

export const PLUGIN_API_VERSION = 0;

export interface OctomuxPlugin {
  apply(ctx: PluginContext): void | Promise<void>;
  /** REQUIRED for any plugin owning out-of-process state (worktrees, tmux, files
   *  written into a repo). Runs at boot after the DB is open. */
  reconcile?(ctx: PluginContext): Promise<void>;
}
