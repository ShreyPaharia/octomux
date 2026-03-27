#!/usr/bin/env node

/**
 * Post-build verification: ensures all imports in bin/octomux.js
 * resolve to files that actually exist in the build output.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const binFile = path.join(root, 'bin', 'octomux.js');

const source = readFileSync(binFile, 'utf8');
const importRegex = /import\(['"](\.\.[^'"]+)['"]\)/g;

let failed = false;
for (const match of source.matchAll(importRegex)) {
  const specifier = match[1];
  const resolved = path.resolve(path.dirname(binFile), specifier);
  if (!existsSync(resolved)) {
    console.error(`\u274c Missing build output: ${specifier} (expected at ${resolved})`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log('\u2705 All bin/octomux.js imports resolve to existing files');
}
