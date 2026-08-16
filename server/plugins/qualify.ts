/**
 * Turns a plugin's bare id/package name plus a bare local id (kind, harness id,
 * provider kind, …) into the one qualified form every registry stores it under:
 * `<pkg>:<local>`.
 *
 * `KIND_NAME_RE` (`server/workflows/presets.ts`) is the path-traversal guard for
 * `PUT`/`DELETE /api/kinds/:kind` — it stays exactly as-is and is imported here,
 * never edited. `QUALIFIED_KIND_RE` is a registry-key shape only: it is never a
 * path component or a filename, so widening it to allow `:` is safe precisely
 * because nothing here ever writes a qualified string to disk.
 */
import { KIND_NAME_RE } from '../workflows/presets.js';

export const QUALIFIED_KIND_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

/**
 * `@foo/bar` -> `foo-bar`; `octomux-plugin-x` -> unchanged.
 *
 * Deliberately does not lowercase or otherwise repair the input — a name that
 * still fails `KIND_NAME_RE` after sanitizing (uppercase, `..`, anything with a
 * character outside `[a-z0-9-]`) is rejected by `qualify()`, not silently fixed.
 */
export function sanitizePackageName(pkg: string): string {
  return pkg.startsWith('@') ? pkg.slice(1).replace(/\//g, '-') : pkg;
}

/**
 * `qualify('demo', 'changelog') === 'demo:changelog'`.
 *
 * Throws if `localId` fails `KIND_NAME_RE`, or if the sanitized `pluginId`
 * fails it (covers scoped package names passed directly, and doubles as the
 * `..`/uppercase guard since `KIND_NAME_RE` cannot match either).
 */
export function qualify(pluginId: string, localId: string): string {
  const sanitized = sanitizePackageName(pluginId);
  if (!KIND_NAME_RE.test(sanitized)) {
    throw new Error(`invalid plugin id "${pluginId}" (sanitized: "${sanitized}")`);
  }
  if (!KIND_NAME_RE.test(localId)) {
    throw new Error(`invalid local id "${localId}"`);
  }
  return `${sanitized}:${localId}`;
}
