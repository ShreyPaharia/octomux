/**
 * Loader + registry merge for schedule-kind presets
 * (spec/schedule-kinds-as-presets.md §3). A preset is a JSON file — display
 * metadata, a default cron, an optional prompt body, and optional
 * config/output JSON Schemas — read only when the UI builds a create form or
 * at boot to populate the workflow registry. It is not a runtime dependency
 * of `executeScheduleRun`, which reads only the schedule row (§1).
 *
 * Three tiers: built-in (`<pkg>/kinds/*.json`, read-only) → plugin
 * (one `kinds/*.json` dir per package that has an **enabled** row in
 * `octomux.yml`, read-only) → home (`~/.octomux/kinds/*.json`, writable via
 * the UI). Home wins on `kind` collision. A file that fails validation is
 * skipped with a `logger.warn` — never a boot crash (§3.2).
 *
 * The plugin tier is gated on the manifest (`server/plugins/manifest.ts`),
 * not on a directory listing: only packages with an enabled row are scanned,
 * so `disabled: true` actually disables a package, an installed-but-unlisted
 * package (including an npm-hoisted transitive dependency that happens to
 * ship a `kinds/` dir) contributes nothing, and a manifest that fails to
 * read/parse is a `logger.warn` + zero plugins, never a boot crash — same
 * policy as a malformed preset file.
 *
 * A plugin's `kinds/*.json` declares a **bare** kind matching its filename
 * stem, exactly like the other two tiers — `checkPresetShape`/`KIND_NAME_RE`
 * reject a `pkg:kind` string outright (plan "S3"). The loader calls
 * `qualify()` *after* shape validation passes, so the registered/returned
 * `kind` is always `<row.id>:<kind>`. That namespacing is what makes a
 * plugin kind structurally unable to shadow a built-in or home id — no
 * dedicated collision check is needed, only a test proving it.
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { builtInKindsDir, homeKindsDir } from '../octomux-paths.js';
import { pluginKindsDir, manifestPath } from '../plugins/paths.js';
import { readManifest } from '../plugins/manifest.js';
import { qualify, KIND_NAME_RE } from '../plugins/qualify.js';
import { registerWorkflow, getWorkflow } from './registry.js';
import { isValidJsonSchema } from './config.js';
import { isValidCronExpression } from '../schedules/cron.js';
import { runSession } from './session-runner.js';
import type { JsonSchema } from '../services/output-contract.js';
import type { PluginRow } from '@octomux/plugin-api';

const logger = childLogger('workflows/presets');

// Re-exported so `server/routes/kinds.ts` — the path-traversal guard for
// `PUT`/`DELETE /api/kinds/:kind` — keeps importing it from here unchanged.
// The definition now lives in `server/plugins/qualify.ts` so that
// `server/plugins/manifest.ts` (the YAML trust boundary) doesn't have to
// import through this file, which pulls in `db.ts`, `pty.ts`,
// `session-runner.ts`, `croner`, and ~25 other modules transitively.
export { KIND_NAME_RE };

export type PresetTier = 'builtin' | 'plugin' | 'home';

export interface Preset {
  kind: string;
  displayName: string;
  execution: 'session' | 'task' | 'chat';
  defaultCron?: string;
  prompt?: string;
  config?: JsonSchema;
  output?: JsonSchema;
}

export interface PresetWithSource extends Preset {
  source: PresetTier;
}

let presets = new Map<string, PresetWithSource>();

function readJsonFilesInDir(dir: string): Array<{ file: string; data: unknown }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out: Array<{ file: string; data: unknown }> = [];
  for (const file of names) {
    const full = path.join(dir, file);
    try {
      out.push({ file, data: JSON.parse(fs.readFileSync(full, 'utf-8')) });
    } catch (err) {
      logger.warn({ file: full, err }, 'preset: unparseable JSON — skipped');
    }
  }
  return out;
}

export type PresetCheckResult = { ok: true; preset: Preset } | { ok: false; error: string };

/**
 * Validate one preset's parsed JSON per §3.2, against an `expectedKind` (the
 * filename stem for a file on disk, or the `:kind` URL param for the
 * `PUT /api/kinds/:kind` route). Pure — never logs, never throws — so both the
 * warn-and-skip file loader and the 400-on-invalid API route can share it.
 */
export function checkPresetShape(
  data: unknown,
  tier: PresetTier,
  expectedKind: string,
): PresetCheckResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'preset must be a JSON object' };
  }
  const p = data as Record<string, unknown>;

  if (typeof p.kind !== 'string' || !KIND_NAME_RE.test(p.kind)) {
    return { ok: false, error: 'missing or invalid `kind` (must match ^[a-z0-9][a-z0-9-]*$)' };
  }
  if (p.kind !== expectedKind) {
    return { ok: false, error: `\`kind\` ("${p.kind}") must equal "${expectedKind}"` };
  }
  if (typeof p.displayName !== 'string' || !p.displayName.trim()) {
    return { ok: false, error: 'missing `displayName`' };
  }
  if (p.execution !== 'session' && p.execution !== 'task' && p.execution !== 'chat') {
    return { ok: false, error: 'missing or invalid `execution` (session|task|chat)' };
  }
  if ((tier === 'home' || tier === 'plugin') && p.execution !== 'session') {
    return { ok: false, error: `${tier}-tier presets must be execution:session` };
  }
  if (p.config !== undefined && !isValidJsonSchema(p.config)) {
    return { ok: false, error: 'invalid `config` JSON Schema' };
  }
  if (p.output !== undefined && !isValidJsonSchema(p.output)) {
    return { ok: false, error: 'invalid `output` JSON Schema' };
  }
  if (p.defaultCron !== undefined) {
    if (typeof p.defaultCron !== 'string' || !isValidCronExpression(p.defaultCron)) {
      return { ok: false, error: 'invalid `defaultCron`' };
    }
  }
  if (p.prompt !== undefined && typeof p.prompt !== 'string') {
    return { ok: false, error: '`prompt` must be a string' };
  }
  if ((p.execution === 'task' || p.execution === 'chat') && !getWorkflow(p.kind)?.run) {
    return {
      ok: false,
      error: 'execution task/chat requires an already-registered code handler for this kind',
    };
  }

  return {
    ok: true,
    preset: {
      kind: p.kind,
      displayName: p.displayName,
      execution: p.execution,
      defaultCron: typeof p.defaultCron === 'string' ? p.defaultCron : undefined,
      prompt: typeof p.prompt === 'string' ? p.prompt : undefined,
      config: p.config as JsonSchema | undefined,
      output: p.output as JsonSchema | undefined,
    },
  };
}

/** Validate one preset file's parsed JSON per §3.2. Returns null (with a
 * `logger.warn`) on any rejection — never throws. */
function validatePreset(file: string, data: unknown, tier: PresetTier): PresetWithSource | null {
  const stem = file.replace(/\.json$/, '');
  const result = checkPresetShape(data, tier, stem);
  if (!result.ok) {
    logger.warn({ file, tier, error: result.error }, 'preset: validation failed — skipped');
    return null;
  }
  return { ...result.preset, source: tier };
}

/**
 * Enabled plugin rows from `octomux.yml` (`disabled: true` rows excluded). A
 * manifest that doesn't exist yields `{ plugins: [] }` (see
 * `readManifest`) — that's the normal fresh-install state, not a warning. A
 * manifest that exists but fails to read/parse is a `logger.warn` + zero
 * plugins, matching the "never a boot crash" policy every other tier here
 * already follows.
 */
function listEnabledPluginRows(): PluginRow[] {
  try {
    return readManifest(manifestPath()).plugins.filter((row) => !row.disabled);
  } catch (err) {
    logger.warn({ err }, 'plugin manifest: read/parse failed — treating as zero plugins');
    return [];
  }
}

/**
 * A row's `kinds/*.json` directory. `row.name` is either an npm package name
 * (resolved under `pluginModulesDir()`, via `pluginKindsDir()` from
 * `server/plugins/paths.ts` — reused as-is, not recomputed here) or an
 * absolute local path (dev loop, `octomux plugins link`-style), which lives
 * outside `pluginModulesDir()` entirely and is used directly.
 *
 * Scoped packages (`@scope/name`) fall out of this for free: `path.join`
 * treats `row.name` as one string, so `pluginKindsDir('@scope/name')` already
 * produces the correct two-level `pluginModulesDir()/@scope/name/kinds` path
 * — no special-casing needed once enumeration is manifest-driven instead of
 * a directory listing (the old `listPluginPackages()` had to filter `@`
 * prefixes out because it couldn't otherwise tell a scope directory from a
 * package directory; that problem doesn't exist when the manifest already
 * names the exact package).
 *
 * The symlink bug (`e.isDirectory()` false for a symlink — breaks `npm link`
 * and makes the whole tier a no-op under pnpm) is moot for the same reason:
 * there is no top-level `fs.readdirSync(..., { withFileTypes: true })` scan
 * left to filter. `readJsonFilesInDir` below calls plain `fs.readdirSync`
 * on the resolved `kinds` dir, which follows symlinks transparently.
 */
function pluginKindsDirFor(row: PluginRow): string {
  return path.isAbsolute(row.name) ? path.join(row.name, 'kinds') : pluginKindsDir(row.name);
}

/**
 * Validate + qualify every kind preset shipped by one enabled plugin row.
 * The file on disk declares a bare kind matching its filename stem (checked
 * against `tier: 'plugin'`, same shape rules as built-in/home); `qualify()`
 * runs only after that passes, so a malformed id is a `logger.warn` + skip
 * here too — never a boot crash.
 *
 * Qualifies against `row.id` (the manifest's own bare, `KIND_NAME_RE`
 * -validated identifier — already checked by `manifest.ts`), not `row.name`.
 * `row.name` can be an absolute path or contain `/` (scoped packages), neither
 * of which is a safe or meaningful namespace segment; `row.id` is guaranteed
 * to already be exactly that.
 */
function loadPluginPresetsFor(row: PluginRow): PresetWithSource[] {
  const out: PresetWithSource[] = [];
  for (const { file, data } of readJsonFilesInDir(pluginKindsDirFor(row))) {
    const preset = validatePreset(file, data, 'plugin');
    if (!preset) continue;
    let qualifiedKind: string;
    try {
      qualifiedKind = qualify(row.id, preset.kind);
    } catch (err) {
      logger.warn({ id: row.id, file, err }, 'preset: plugin kind qualification failed — skipped');
      continue;
    }
    out.push({ ...preset, kind: qualifiedKind });
  }
  return out;
}

/**
 * Load built-in, then plugin, then home presets into the in-memory map
 * (home wins on `kind`). Call once at boot (after every side-effect workflow
 * import has registered its code handler — task/chat validation depends on
 * it) and again whenever the UI writes a home preset.
 */
export function loadPresets(): Map<string, PresetWithSource> {
  const map = new Map<string, PresetWithSource>();

  for (const { file, data } of readJsonFilesInDir(builtInKindsDir())) {
    const preset = validatePreset(file, data, 'builtin');
    if (preset) map.set(preset.kind, preset);
  }
  for (const row of listEnabledPluginRows()) {
    for (const preset of loadPluginPresetsFor(row)) {
      map.set(preset.kind, preset); // always `<id>:<kind>` — can't collide with builtin/home
    }
  }
  for (const { file, data } of readJsonFilesInDir(homeKindsDir())) {
    const preset = validatePreset(file, data, 'home');
    if (preset) map.set(preset.kind, preset); // home wins
  }

  presets = map;
  return map;
}

export function getPreset(kind: string): PresetWithSource | undefined {
  return presets.get(kind);
}

export function listPresets(): PresetWithSource[] {
  return Array.from(presets.values());
}

/**
 * Merge presets with code-registered handlers into the effective workflow
 * registry (§3.4). `getWorkflow(kind)` keeps its current signature and return
 * shape — this only overlays preset display metadata (displayName, execution,
 * config, output) onto whatever `run`/`surfaces`/`trigger`/`apiRouter` the
 * kind's own `index.ts` already registered (doc-drift, prod-log-triage,
 * daily-plan, weekly-update, overnight-log-summary, slack-watcher). A preset
 * with no registered code handler (`custom`, or any home-tier kind) is
 * synthesized as a fresh `session` workflow backed by the generic session
 * runner. Idempotent — safe to call again after a preset reload.
 */
export function mergePresetsIntoRegistry(): void {
  for (const preset of presets.values()) {
    const existing = getWorkflow(preset.kind);
    if (existing) {
      registerWorkflow({
        ...existing,
        displayName: preset.displayName,
        execution: preset.execution,
        config: preset.config ?? existing.config,
        output: preset.output ?? existing.output,
      });
      continue;
    }

    if (preset.execution === 'task' || preset.execution === 'chat') {
      // Load-time validation (§3.2) already rejects this combination for a
      // freshly-parsed file; this is a defensive no-op for an edge case where
      // the code handler unregisters between load and merge (never happens
      // today, but merge must not synthesize a fake task/chat run).
      logger.warn(
        { kind: preset.kind, execution: preset.execution },
        'preset: no code handler at merge time — skipped',
      );
      continue;
    }

    const kind = preset.kind;
    registerWorkflow({
      kind,
      displayName: preset.displayName,
      surfaces: ['artifact'],
      execution: 'session',
      config: preset.config,
      output: preset.output,
      trigger: { kind: 'cron' },
      run: (ctx) => {
        // Fire-and-forget: runSession blocks for the full headless agent run,
        // and the poller loop must not stall on one schedule (matches every
        // other session-execution kind's index.ts wiring).
        void runSession({ ...ctx, kind }).catch((err) => {
          logger.error(
            { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId, kind },
            'preset session run failed',
          );
        });
        return Promise.resolve();
      },
    });
  }
}

/** Load presets from disk and merge into the registry in one call — the boot
 * entry point (`workflows/index.ts`) and the UI's write-then-reload path. */
export function reloadPresets(): void {
  loadPresets();
  mergePresetsIntoRegistry();
}
