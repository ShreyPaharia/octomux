#!/usr/bin/env node
/**
 * Fallback launcher, used only when postinstall didn't replace `bin/octomux`
 * with the native binary (`--ignore-scripts`, some pnpm configs).
 *
 * The normal path execs the binary directly with no Node process resident; this
 * one keeps one alive for the session, so prefer `npm rebuild octomux`.
 */

const { spawnSync } = require('child_process');
const { platformPackage } = require('./platform.cjs');

const pkg = platformPackage();
let binary;
try {
  binary = pkg && require(pkg).octomuxBin;
} catch {
  binary = null;
}

if (!binary) {
  console.error(
    `octomux: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      (pkg ? `Expected the optional dependency ${pkg} to be installed.\n` : '') +
      `\nReinstall without --omit=optional, or build from source:\n` +
      `  git clone https://github.com/ShreyPaharia/octomux && cd octomux\n` +
      `  bun install && bun run build:binary\n`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`octomux: failed to run ${binary}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
