/**
 * Manifest parsing + validation only. No loading, no `import()` — that is the
 * loader's job (server/plugins/loader.ts, a later task).
 *
 * `octomux.yml` lists which plugin packages are installed. It is a **trust
 * boundary**: the YAML parser is pinned to `JSON_SCHEMA`, which recognises only
 * JSON-shaped scalars/collections and has no custom-tag resolvers. Any `!!tag`
 * (e.g. `!!js/function`) throws instead of silently resolving to something
 * truthy. This mirrors dsh's own postmortem 0002: an uninterpolated
 * `disabled: !!js …` expression node was truthy and silently disabled their
 * entire filesystem tool stack while every check passed. Config stays data —
 * do not switch this to `yaml.DEFAULT_SCHEMA` or plain `yaml.load(text)`.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { KIND_NAME_RE } from './qualify.js';
import type { PluginManifest, PluginRow } from '@octomux/plugin-api';

function fail(msg: string): never {
  throw new Error(`invalid plugin manifest: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(['plugins']);
const ALLOWED_ROW_KEYS = new Set(['id', 'name', 'version', 'integrity', 'config', 'disabled']);

// npm package name shape (scoped or unscoped) — deliberately stricter than npm's
// own rules (no dots-only segments, no leading dot/underscore weirdness) since
// this only needs to admit real package names, not validate npm's full grammar.
const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

/**
 * `import()`-safe: an npm package name or an absolute filesystem path, nothing
 * else. `import()` natively resolves `data:`, `http(s):`, `file:` — a `name`
 * that parses as any of those (or as a relative/traversal-shaped path) is
 * direct code execution once the loader (`server/plugins/loader.ts`) imports
 * it. `path.isAbsolute` alone is not enough: it also accepts `\0` mid-string on
 * POSIX, so NUL is rejected explicitly.
 */
function isSafePluginName(name: string): boolean {
  if (name.includes('\0')) return false;
  return NPM_PACKAGE_NAME_RE.test(name) || path.isAbsolute(name);
}

// A config manifest has no legitimate need for YAML anchors/aliases. Per the
// YAML spec, `&`/`*` are only ever anchor/alias indicators when they are the
// FIRST character of a node — i.e. immediately after another node-start token
// (`:`, `,`, `[`, `{`, whitespace) or at the start of a line — a plain scalar
// can never begin with them unquoted. So this is a precise (not heuristic)
// detector, not a best-effort scan, once quoted spans are blanked out first.
// A ~560-byte manifest chaining anchors/aliases can expand to 60+ MB in the
// low tens of milliseconds (shared-reference blowup once anything walks or
// serializes the tree) — reject before `yaml.load` ever runs, not after.
const ANCHOR_OR_ALIAS_RE = /(^|[\s,:[{])[&*][^\s,}\]]+/m;

function blankQuotedSpans(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
}

function rejectAnchorsAndAliases(text: string): void {
  if (ANCHOR_OR_ALIAS_RE.test(blankQuotedSpans(text))) {
    fail('YAML anchors/aliases are not allowed (no legitimate use in a plugin manifest)');
  }
}

function checkRow(row: unknown, index: number): PluginRow {
  if (!isPlainObject(row)) {
    fail(`plugins[${index}] must be an object`);
  }

  for (const key of Object.keys(row)) {
    if (!ALLOWED_ROW_KEYS.has(key)) {
      fail(`plugins[${index}] has unknown key "${key}"`);
    }
  }

  const { id, name, version, integrity, config, disabled } = row;

  if (typeof id !== 'string' || !KIND_NAME_RE.test(id)) {
    fail(`plugins[${index}].id must match ${KIND_NAME_RE} (got ${JSON.stringify(id)})`);
  }
  // A row identifies its source by either an npm package name or an absolute
  // local path (dev loop). The loader (`server/plugins/loader.ts`) will
  // `import()` this value, and `import()` natively resolves `data:`,
  // `http(s):`, `file:` URLs — so this is a parse-time security boundary, not
  // just a shape check. Anything that isn't one of those two forms (a URL
  // scheme, a relative/traversal path, an embedded NUL) is rejected here.
  if (typeof name !== 'string' || !isSafePluginName(name)) {
    fail(`plugins[${index}].name must be an npm package name or an absolute path`);
  }
  if (version !== undefined && typeof version !== 'string') {
    fail(`plugins[${index}].version must be a string`);
  }
  if (integrity !== undefined && typeof integrity !== 'string') {
    fail(`plugins[${index}].integrity must be a string`);
  }
  if (config !== undefined && !isPlainObject(config)) {
    fail(`plugins[${index}].config must be an object`);
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    fail(`plugins[${index}].disabled must be a boolean`);
  }

  return {
    id,
    name,
    ...(version !== undefined ? { version } : {}),
    ...(integrity !== undefined ? { integrity } : {}),
    ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

/** Parses and validates manifest YAML. Throws on any shape violation. */
export function parseManifest(text: string): PluginManifest {
  rejectAnchorsAndAliases(text);

  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    fail(`YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (doc === undefined || doc === null) {
    return { plugins: [] };
  }
  if (!isPlainObject(doc)) {
    fail('top level must be an object');
  }

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      fail(`unknown top-level key "${key}"`);
    }
  }

  const rawPlugins = doc.plugins;
  if (rawPlugins === undefined) {
    return { plugins: [] };
  }
  if (!Array.isArray(rawPlugins)) {
    fail('"plugins" must be an array');
  }

  const seenIds = new Set<string>();
  const plugins = rawPlugins.map((row, index) => {
    const checked = checkRow(row, index);
    if (seenIds.has(checked.id)) {
      fail(`duplicate plugin id "${checked.id}"`);
    }
    seenIds.add(checked.id);
    return checked;
  });

  return { plugins };
}

/** Reads + parses the manifest at `file`. A missing file is `{ plugins: [] }`,
 * never an error — a fresh install has no manifest yet. A file that exists but
 * fails to parse still throws, same as `parseManifest`. */
export function readManifest(file: string): PluginManifest {
  if (!fs.existsSync(file)) {
    return { plugins: [] };
  }
  const text = fs.readFileSync(file, 'utf-8');
  return parseManifest(text);
}
