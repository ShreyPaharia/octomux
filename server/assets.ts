/**
 * Where octomux's bundled asset trees (skills/, agents/, templates/, workflows/,
 * dist/) live at runtime.
 *
 * Running from source they're just files in the repo. Inside a
 * `bun build --compile` binary there is no repo — `__dirname` points at the
 * read-only `/$bunfs` and nothing can be exec'd or served from there. So the
 * trees are embedded as base64 by `scripts/bundle-assets.mjs` and unpacked once
 * into `<octomuxRoot()>/runtime/<version>/`, which is what `assetRoot()` returns.
 *
 * Extraction is keyed on the version directory, so upgrading the binary lays
 * down a fresh tree and downgrades keep working.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { octomuxRoot } from './octomux-root.js';
import pkg from '../package.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** True when running inside a compiled single-file binary. */
export const isCompiled = __dirname.includes('$bunfs');

let cachedRoot: string | null = null;

export function assetRoot(): string {
  if (cachedRoot) return cachedRoot;

  if (!isCompiled) {
    cachedRoot = path.resolve(__dirname, '..');
    return cachedRoot;
  }

  cachedRoot = extractBundle();
  return cachedRoot;
}

function extractBundle(): string {
  // Imported lazily so running from source never pays to parse the blob (and so
  // a source checkout without a generated bundle still starts).
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must resolve synchronously; assetRoot() is called from sync code paths
  const bundle = require('./assets.generated.json') as Record<string, string>;
  const version = pkg.version;
  const dir = path.join(octomuxRoot(), 'runtime', version);
  const stamp = path.join(dir, '.complete');

  if (fs.existsSync(stamp)) return dir;

  for (const [rel, base64] of Object.entries(bundle)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
  }

  // Written last so a crash mid-extract re-extracts next boot instead of
  // leaving a half-populated tree that looks complete.
  fs.writeFileSync(stamp, version);
  return dir;
}
