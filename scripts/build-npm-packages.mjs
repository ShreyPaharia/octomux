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

// Keep the root package's pins in step with the version just staged. They are
// exact pins, so a release bump would otherwise leave them pointing at the
// previous version and npm would install a stale binary.
const rootPkgPath = path.join(root, 'package.json');
const rootManifest = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
let repinned = 0;
for (const name of Object.keys(rootManifest.optionalDependencies ?? {})) {
  if (
    name.startsWith('@octomux/cli-') &&
    rootManifest.optionalDependencies[name] !== rootPkg.version
  ) {
    rootManifest.optionalDependencies[name] = rootPkg.version;
    repinned++;
  }
}
if (repinned > 0) {
  writeFileSync(rootPkgPath, JSON.stringify(rootManifest, null, 2) + '\n');
  console.log(`\n  re-pinned ${repinned} optionalDependencies to ${rootPkg.version}`);
}

if (staged === 0) {
  console.error('\n❌ nothing staged — build the binaries first: bun run build:binary:all');
  process.exit(1);
}

console.log(
  `\n✅ ${staged} package(s) in dist-npm/ at v${rootPkg.version}\n` +
    `   publish each, then the root package (its optionalDependencies pin this version)`,
);
