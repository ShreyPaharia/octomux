#!/usr/bin/env bun
/**
 * Bundle the runtime asset trees into a single JSON blob the compiled binary can
 * embed.
 *
 * `bun build --compile` produces one file, but octomux needs several of these
 * assets to exist as *real files on disk*: Claude Code reads skills from
 * ~/.claude/skills, hook templates get copied into repos, and express.static
 * serves the SPA from a directory. So they ride along as base64 in
 * `server/assets.generated.json` and `server/assets.ts` unpacks them on first
 * run. See `assetRoot()` there.
 *
 * Run as part of `bun run build`, before the compile step.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `plugin`, not `skills`/`agents`: the skills and agent roles live at
// plugin/skills and plugin/agents, and builtInSkillsDir() resolves
// `<assetRoot()>/plugin/skills`. Naming the leaf dirs here silently bundled
// neither — the compiled binary shipped zero skills until this was fixed.
const TREES = ['plugin', 'kinds', 'templates', 'workflows', 'dist', '.config'];
// Single runtime-needed files outside the trees: the cursor harness copies the
// hook bridge into each workspace (resolveBridgeSource in harnesses/cursor.ts).
const FILES = ['bin/octomux-hook-bridge.js'];
const OUT = path.join(root, 'server', 'assets.generated.json');

function walk(dir, base, out) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
}

const bundle = {};
let bytes = 0;

for (const tree of TREES) {
  const dir = path.join(root, tree);
  if (!existsSync(dir)) {
    console.warn(`⚠  skipping missing asset tree: ${tree}`);
    continue;
  }
  const files = [];
  walk(dir, root, files);
  for (const rel of files) {
    const buf = readFileSync(path.join(root, rel));
    bundle[rel] = buf.toString('base64');
    bytes += buf.length;
  }
  console.log(`  ${tree}: ${files.length} files`);
}

for (const rel of FILES) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) {
    console.warn(`⚠  skipping missing asset file: ${rel}`);
    continue;
  }
  const buf = readFileSync(abs);
  bundle[rel] = buf.toString('base64');
  bytes += buf.length;
  console.log(`  ${rel}`);
}

writeFileSync(OUT, JSON.stringify(bundle));
console.log(
  `\n✅ ${Object.keys(bundle).length} files → ${path.relative(root, OUT)} ` +
    `(${(bytes / 1024 / 1024).toFixed(1)} MB raw)`,
);
