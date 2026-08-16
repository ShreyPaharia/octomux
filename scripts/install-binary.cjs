#!/usr/bin/env node
/**
 * Postinstall: put the real binary where npm linked `bin/octomux`.
 *
 * octomux ships as a compiled Bun binary, one `@octomux/cli-<platform>-<arch>`
 * optional dependency per target. This resolves the one matching the host and
 * overwrites the `bin/octomux` placeholder with it — so `octomux` execs native
 * code directly, with no Node process sitting in the middle for the whole
 * session. Hardlink first (free), copy if that's not possible (separate
 * filesystems, or no link permission).
 *
 * Never fails the install: if the platform package is missing the placeholder
 * stays, and it explains itself when run. `bin/cli-wrapper.cjs` is the manual
 * fallback for that case.
 */

const { chmodSync, copyFileSync, existsSync, linkSync, unlinkSync } = require('fs');
const path = require('path');
const { platformPackage } = require('../bin/platform.cjs');

const dest = path.join(__dirname, '..', 'bin', 'octomux');
const pkg = platformPackage();

if (!pkg) {
  console.warn(
    `octomux: no prebuilt binary for ${process.platform}-${process.arch}; ` +
      `leaving the placeholder in place.`,
  );
  process.exit(0);
}

let source;
try {
  source = require(pkg).octomuxBin;
} catch {
  console.warn(
    `octomux: optional dependency ${pkg} is not installed — leaving the placeholder in place.\n` +
      `        Run \`npm rebuild octomux\` after installing it.`,
  );
  process.exit(0);
}

if (!source || !existsSync(source)) {
  console.warn(`octomux: ${pkg} resolved but its binary is missing; leaving the placeholder.`);
  process.exit(0);
}

try {
  if (existsSync(dest)) unlinkSync(dest);
  try {
    linkSync(source, dest);
  } catch {
    copyFileSync(source, dest);
  }
  chmodSync(dest, 0o755);
} catch (err) {
  console.warn(`octomux: could not install the binary (${err.message}); use bin/cli-wrapper.cjs.`);
}
