import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';

const logger = childLogger('instruction-files');

const MAX_SIZE_BYTES = 64 * 1024;

const ROOT_MATCHES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'REVIEW.md',
  '.cursorrules',
  '.windsurfrules',
]);

const SUFFIX_MATCHES = ['.rules', '.mdc'];

const SCOPE_CARRIER_DIRS = new Set(['.agents', '.devin', '.cursor', '.github']);

export interface InstructionFile {
  path: string;
  scope: string;
  size: number;
}

/**
 * Locate instruction files in the worktree.
 *
 * - Matches well-known filenames (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, REVIEW.md,
 *   .cursorrules, .windsurfrules) anywhere in the tree.
 * - Matches `*.rules` / `*.mdc` anywhere in the tree.
 * - When a match lives under `.agents/`, `.devin/`, `.cursor/`, or `.github/`,
 *   its scope is the directory containing that carrier — e.g.
 *   `src/.agents/REVIEW.md` has scope `src/`. The agent should treat it as
 *   applying only to paths under `src/`.
 * - Skips files larger than 64KB (logs a warning).
 * - Skips `node_modules/` and `.git/`.
 */
export function findInstructionFiles(worktreeRoot: string): InstructionFile[] {
  const results: InstructionFile[] = [];
  walk(worktreeRoot, worktreeRoot, results);
  return results;
}

function walk(root: string, dir: string, out: InstructionFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(root, abs, out);
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!matches(e.name)) continue;
    const stat = fs.statSync(abs);
    if (stat.size > MAX_SIZE_BYTES) {
      logger.warn({ path: rel, size: stat.size }, 'instruction file too large; skipping');
      continue;
    }
    out.push({ path: rel, scope: scopeFor(rel), size: stat.size });
  }
}

function matches(filename: string): boolean {
  if (ROOT_MATCHES.has(filename)) return true;
  for (const suffix of SUFFIX_MATCHES) {
    if (filename.endsWith(suffix)) return true;
  }
  return false;
}

function scopeFor(relPath: string): string {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (SCOPE_CARRIER_DIRS.has(parts[i])) {
      const prefix = parts.slice(0, i).join('/');
      return prefix === '' ? 'root' : prefix + '/';
    }
  }
  return 'root';
}
