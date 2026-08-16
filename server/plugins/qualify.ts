/**
 * Turns a plugin's bare id/package name plus a bare local id (kind, harness id,
 * provider kind, …) into the one qualified form every registry stores it under:
 * `<pkg>:<local>`.
 *
 * `KIND_NAME_RE` lives here (not in `server/workflows/presets.ts`) so that
 * `server/plugins/manifest.ts` — the YAML **trust boundary** — never has to
 * import through `presets.ts`, which pulls in `db.ts`, `pty.ts`,
 * `session-runner.ts`, `croner`, and ~25 other modules transitively.
 * `presets.ts` re-exports it from here so `server/routes/kinds.ts` (which
 * imports it from `presets.js`) keeps working unchanged. It is the
 * path-traversal guard for `PUT`/`DELETE /api/kinds/:kind` — a name that
 * matches it can never contain `..` or a path separator. Do not edit its
 * shape without checking that route.
 */
export const KIND_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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
