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
import yaml from 'js-yaml';
import { KIND_NAME_RE } from '../workflows/presets.js';
import type { PluginManifest, PluginRow } from '@octomux/plugin-api';

function fail(msg: string): never {
  throw new Error(`invalid plugin manifest: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(['plugins']);
const ALLOWED_ROW_KEYS = new Set(['id', 'name', 'version', 'integrity', 'config', 'disabled']);

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
  // local path (dev loop) — both are just a non-empty `name` string. Only the
  // "neither" case (missing/blank name) is a parse-time rejection; distinguishing
  // package-name-shaped from path-shaped is the loader's resolve step, not ours.
  if (typeof name !== 'string' || name.trim().length === 0) {
    fail(`plugins[${index}].name must be a non-empty string (package name or absolute path)`);
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
