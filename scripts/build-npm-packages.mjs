#!/usr/bin/env bun
/**
 * Stage the publishable npm packages.
 *
 * octomux ships as a compiled Bun binary, so the root package can't contain the
 * program — it's platform-specific. Same shape as the bundled tmux: one
 * `@octomux/cli-<platform>-<arch>` package per target carrying its binary, each
 * marked with `os`/`cpu` so npm installs only the matching one, all listed as
 * optional dependencies of the root package.
 *
 * Run after `build:binary:all`; output lands in `dist-npm/`.
 *
 *   bun scripts/build-npm-packages.mjs
 *   npm publish dist-npm/cli-darwin-arm64   # …and the rest, then the root
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist-npm');

/** Must match the `--target=bun-*` list in `build:binary:all`. */
const TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64-musl', libc: 'musl' },
  { platform: 'linux', arch: 'x64-musl', libc: 'musl' },
];

rmSync(outDir, { recursive: true, force: true });

let staged = 0;
for (const { platform, arch, libc } of TARGETS) {
  const binary = path.join(root, 'dist-bin', `octomux-${platform}-${arch}`);
  if (!existsSync(binary)) {
    console.warn(
      `⚠  missing ${path.relative(root, binary)} — run \`bun run build:binary:all\` first`,
    );
    continue;
  }

  const name = `cli-${platform}-${arch}`;
  const dir = path.join(outDir, name);
  mkdirSync(dir, { recursive: true });

  cpSync(binary, path.join(dir, 'octomux'));
  chmodSync(path.join(dir, 'octomux'), 0o755);

  writeFileSync(
    path.join(dir, 'index.js'),
    "const path = require('path');\nmodule.exports = { octomuxBin: path.join(__dirname, 'octomux') };\n",
  );

  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@octomux/${name}`,
        version: rootPkg.version,
        description: `octomux binary (${platform} ${arch})`,
        license: rootPkg.license,
        repository: rootPkg.repository,
        os: [platform],
        // `arch` carries the libc suffix for musl builds; cpu must not.
        cpu: [arch.replace(/-musl$/, '')],
        // Linux only. npm 10.4+/pnpm/yarn honour this so glibc and musl builds
        // don't both match; older clients ignore it and fall back to the runtime
        // detection in scripts/install-binary.cjs.
        ...(platform === 'linux' ? { libc: [libc ?? 'glibc'] } : {}),
        main: 'index.js',
        files: ['index.js', 'octomux'],
      },
      null,
      2,
    ) + '\n',
  );

  staged++;
  console.log(`  staged @octomux/${name}`);
}

// Inject the platform pins into the root manifest.
//
// They are deliberately absent from the checked-in package.json: these packages
// only exist on npm once a release has published them, so pinning them in the
// repo makes every `bun install` 404 on a fresh clone. The published root
// manifest does need them, and they are exact pins, so write them here against
// the version actually staged.
const rootPkgPath = path.join(root, 'package.json');
const rootManifest = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const optional = rootManifest.optionalDependencies ?? {};
let pinned = 0;
for (const { platform, arch } of TARGETS) {
  const name = `@octomux/cli-${platform}-${arch}`;
  if (optional[name] !== rootPkg.version) {
    optional[name] = rootPkg.version;
    pinned++;
  }
}
rootManifest.optionalDependencies = optional;

// Drop `dependencies` from the published manifest.
//
// Nothing in `files` needs node_modules: the CLI is a compiled binary that
// bundles its imports, and bin/*.cjs + scripts/*.cjs only require the platform
// package (an optionalDependency, pinned above). Shipping them is not merely
// dead weight — the workspace packages are declared `workspace:*`, a protocol
// npm cannot resolve from the registry, so `npm i octomux` died with
// EUNSUPPORTEDPROTOCOL on every published version through 1.4.0.
delete rootManifest.dependencies;

writeFileSync(rootPkgPath, JSON.stringify(rootManifest, null, 2) + '\n');
console.log(`\n  pinned ${pinned} platform package(s) at ${rootPkg.version} in package.json`);
console.log('  dropped `dependencies` — the binary bundles them');
console.log('  (expected to show as a local edit — it is a release-time change)');

if (staged === 0) {
  console.error('\n❌ nothing staged — build the binaries first: bun run build:binary:all');
  process.exit(1);
}

console.log(
  `\n✅ ${staged} package(s) in dist-npm/ at v${rootPkg.version}\n` +
    `   publish each, then the root package (its optionalDependencies pin this version)`,
);
