import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import { resolveDiffBase } from './diff-base.js';
import {
  WORKDIR,
  rangeIncludesWorkingTree,
  rangeNameStatusArgs,
  rangeNewRef,
  rangeNumstatArgs,
  rangeOldRef,
} from './diff-range.js';
import { listReviewState } from './file-review-state.js';
import type { DiffRange, Task } from './types.js';

const execFile = promisify(execFileCb);
const logger = childLogger('diff');

export const MAX_FILE_BYTES = 1_048_576; // 1 MiB
export const MAX_IGNORED_FILES = 200;

// Paths starting with any of these are filtered out of the ignored-files list
// entirely — they're always-huge caches/builds that provide no useful review signal.
export const IGNORED_DENY_PREFIXES = [
  'node_modules/',
  '.git/',
  '.next/',
  'dist/',
  'dist-server/',
  'coverage/',
  '.cache/',
  '.vite/',
  '.pnp/',
  '.yarn/',
  '.turbo/',
  '.parcel-cache/',
  '__pycache__/',
  '.pytest_cache/',
  'target/',
  'build/',
  'out/',
  '.DS_Store',
];

export type FileStatus = 'A' | 'M' | 'D' | 'B';

export interface DiffFileEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  ignored?: boolean;
  tooLarge?: boolean;
  binary?: boolean;
  post_blob_sha?: string | null;
  reviewed?: boolean;
  reviewed_at?: string | null;
  reviewed_at_commit?: string | null;
  changed_since_review?: boolean;
}

export interface DiffSummary {
  files: DiffFileEntry[];
  ignoredTruncated?: boolean;
  base_sha: string;
  base_ref: string;
  base_is_stale: boolean;
  reviewed_count: number;
  total_count: number;
}

export interface FileDiff {
  oldContent: string;
  newContent: string;
  status: FileStatus;
  tooLarge: boolean;
  binary: boolean;
  isDirectory: boolean;
}

// Strip GIT_* env vars so our git calls target the worktree we pass via -C,
// not whatever repo an outer caller (e.g. a git hook) happens to be in.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

export async function blobAt(opts: {
  worktree: string;
  commit: string;
  relPath: string;
}): Promise<string | null> {
  const { worktree, commit, relPath } = opts;
  try {
    const stdout = await git(worktree, ['ls-tree', commit, '--', relPath]);
    const line = stdout.trim();
    if (!line) return null;
    // format: "<mode> blob <sha>\t<path>"
    const parts = line.split(/\s+/);
    if (parts.length < 3 || parts[1] !== 'blob') return null;
    return parts[2];
  } catch {
    return null;
  }
}

function parseNumstat(
  stdout: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p) continue;
    if (a === '-' && d === '-') {
      out.set(p, { additions: 0, deletions: 0, binary: true });
    } else {
      out.set(p, {
        additions: parseInt(a, 10) || 0,
        deletions: parseInt(d, 10) || 0,
        binary: false,
      });
    }
  }
  return out;
}

async function countLines(filePath: string): Promise<number> {
  const buf = await fs.promises.readFile(filePath);
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
}

export async function getDiffSummary(opts: {
  task: Task;
  range?: DiffRange;
}): Promise<DiffSummary> {
  const { task, range = { kind: 'base' as const } } = opts;
  const worktree = task.run_mode === 'none' ? task.repo_path : task.worktree;
  if (!worktree) throw new Error('Task has no worktree');

  const resolved = await resolveDiffBase(task);
  const base = resolved.sha;

  // Committed numstat — null when range is `working` (only working-tree changes).
  const numstatArgs = rangeNumstatArgs(range, base);
  const committed = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const committedStatus = new Map<string, 'A' | 'M' | 'D'>();
  if (numstatArgs) {
    let committedNumstat = '';
    try {
      committedNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', ...numstatArgs]);
    } catch (err) {
      // For `base`, fall back from three-dot to two-dot (existing behaviour).
      // For commit/range, the args don't use `...`, so this branch is moot.
      if (range.kind === 'base') {
        logger.warn(
          { worktree, base, err: (err as Error).message },
          'three-dot diff failed, falling back',
        );
        committedNumstat = await git(worktree, [
          'diff',
          '--numstat',
          '--no-renames',
          `${base}..HEAD`,
        ]);
      } else {
        throw err;
      }
    }
    for (const [p, v] of parseNumstat(committedNumstat)) committed.set(p, v);

    const nameStatusArgs = rangeNameStatusArgs(range, base);
    const committedNameStatus = nameStatusArgs
      ? await git(worktree, ['diff', '--name-status', '--no-renames', ...nameStatusArgs]).catch(
          () => {
            if (range.kind === 'base') {
              return git(worktree, ['diff', '--name-status', '--no-renames', `${base}..HEAD`]);
            }
            throw new Error('name-status failed');
          },
        )
      : '';
    for (const line of committedNameStatus.split('\n')) {
      if (!line.trim()) continue;
      const [code, ...rest] = line.split('\t');
      const p = rest.join('\t');
      if (!p) continue;
      committedStatus.set(p, (code[0] as 'A' | 'M' | 'D') || 'M');
    }
  }

  // Working tree + untracked are only merged in for `base` (today's behavior)
  // and `working` (uncommitted-only). Historical commit/range views skip them.
  const includeWorking = rangeIncludesWorkingTree(range);
  const working = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const untrackedPaths: string[] = [];
  const deleted = new Set<string>();
  if (includeWorking) {
    const workingNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', 'HEAD']);
    for (const [p, v] of parseNumstat(workingNumstat)) working.set(p, v);

    // -uall expands untracked directories into individual file entries. Without it,
    // git collapses a partially-untracked directory (e.g. `docs/superpowers/` when
    // `docs/` has tracked files but most of `docs/superpowers/` is gitignored) into
    // a single trailing-slash entry, which produces an empty-basename node and an
    // EISDIR when the viewer tries to read it.
    const porcelain = await git(worktree, ['status', '--porcelain=v1', '--no-renames', '-uall']);
    for (const line of porcelain.split('\n')) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3);
      // Belt-and-suspenders: skip any directory entries that slip through (e.g.
      // submodule roots), so they never reach the tree builder as empty leaves.
      if (!p || p.endsWith('/')) continue;
      if (code === '??') untrackedPaths.push(p);
      if (code.includes('D')) deleted.add(p);
    }
  }

  const paths = new Set<string>([...committed.keys(), ...working.keys(), ...untrackedPaths]);

  // For post-image blob SHAs we read the range's "new" ref. For `working` the
  // new side is the working tree (no committed blob), so we leave it null.
  const newRef = rangeNewRef(range);
  const newRefForBlob = newRef === WORKDIR ? null : newRef;

  const files: DiffFileEntry[] = [];
  for (const p of paths) {
    const inCommitted = committed.get(p);
    const inWorking = working.get(p);
    const absPath = path.join(worktree, p);
    const existsOnDisk = fs.existsSync(absPath);

    const binary = (inCommitted?.binary || inWorking?.binary) ?? false;
    let status: FileStatus;
    if (binary) status = 'B';
    else if (deleted.has(p) && !existsOnDisk) status = 'D';
    else if (committedStatus.get(p) === 'A' || (untrackedPaths.includes(p) && !inCommitted))
      status = 'A';
    else if (committedStatus.get(p) === 'D') status = 'D';
    else status = 'M';

    let additions = 0;
    let deletions = 0;
    if (untrackedPaths.includes(p) && existsOnDisk) {
      try {
        additions = await countLines(absPath);
      } catch {
        additions = 0;
      }
    } else if (inWorking && (inWorking.additions || inWorking.deletions)) {
      additions = inWorking.additions;
      deletions = inWorking.deletions;
      if (inCommitted) {
        additions += inCommitted.additions;
        deletions += inCommitted.deletions;
      }
    } else if (inCommitted) {
      additions = inCommitted.additions;
      deletions = inCommitted.deletions;
    }

    const post_blob_sha =
      status === 'D' || newRefForBlob == null
        ? null
        : await blobAt({ worktree, commit: newRefForBlob, relPath: p });
    files.push({ path: p, status, additions, deletions, post_blob_sha });
  }

  // Decorate with review state from the DB. Only non-ignored files
  // (i.e. paths the agent actually changed) participate in the reviewed
  // counter — ignored files are noise and shouldn't gate completion.
  const reviewRows = listReviewState(task.id);
  const reviewByPath = new Map(reviewRows.map((r) => [r.file_path, r]));
  let reviewed_count = 0;

  for (const entry of files) {
    const row = reviewByPath.get(entry.path);
    if (!row) {
      entry.reviewed = false;
      entry.reviewed_at = null;
      entry.reviewed_at_commit = null;
      entry.changed_since_review = false;
      continue;
    }
    const blobAtReviewedCommit = await blobAt({
      worktree,
      commit: row.reviewed_at_commit,
      relPath: entry.path,
    });
    const same =
      blobAtReviewedCommit !== null &&
      entry.post_blob_sha != null &&
      blobAtReviewedCommit === entry.post_blob_sha;
    entry.reviewed = same;
    entry.reviewed_at = row.reviewed_at;
    entry.reviewed_at_commit = row.reviewed_at_commit;
    entry.changed_since_review = !same;
    if (same) reviewed_count++;
  }

  const summary: DiffSummary = {
    files,
    base_sha: resolved.sha,
    base_ref: resolved.ref,
    base_is_stale: resolved.is_stale,
    reviewed_count,
    total_count: files.filter((f) => !f.ignored).length,
  };
  // Ignored files are only meaningful when viewing the working tree (`base`
  // includes worktree+untracked; historical commit/range views don't).
  if (range.kind === 'base') {
    await appendIgnoredFiles(summary, { worktree, knownPaths: paths });
  }

  summary.files.sort((a, b) => a.path.localeCompare(b.path));
  return summary;
}

function isDeniedIgnoredPath(p: string): boolean {
  return IGNORED_DENY_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? p === prefix || p.startsWith(prefix) : p === prefix,
  );
}

async function appendIgnoredFiles(
  summary: DiffSummary,
  opts: { worktree: string; knownPaths: Set<string> },
): Promise<void> {
  const { worktree, knownPaths } = opts;

  let stdout = '';
  try {
    stdout = await git(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  } catch (err) {
    logger.warn(
      { worktree, err: (err as Error).message },
      'ls-files --ignored failed; skipping ignored files',
    );
    return;
  }

  // -z separates entries with NUL (filenames may contain newlines).
  const candidates = stdout.split('\0').filter(Boolean);
  const filtered: string[] = [];
  for (const p of candidates) {
    if (knownPaths.has(p)) continue;
    if (isDeniedIgnoredPath(p)) continue;
    filtered.push(p);
  }
  if (filtered.length > MAX_IGNORED_FILES) {
    summary.ignoredTruncated = true;
    filtered.length = MAX_IGNORED_FILES;
  }

  for (const p of filtered) {
    const abs = path.join(worktree, p);
    let tooLarge = false;
    let binary = false;
    let additions = 0;
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.size > MAX_FILE_BYTES) {
        tooLarge = true;
      } else {
        const buf = await fs.promises.readFile(abs);
        const sniff = buf.subarray(0, Math.min(buf.length, 8192));
        binary = sniff.includes(0);
        if (!binary && buf.length > 0) {
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) additions++;
          if (buf[buf.length - 1] !== 0x0a) additions++;
        }
      }
    } catch {
      continue;
    }
    const entry: DiffFileEntry = {
      path: p,
      status: 'A',
      additions,
      deletions: 0,
      ignored: true,
    };
    if (tooLarge) entry.tooLarge = true;
    if (binary) entry.binary = true;
    summary.files.push(entry);
  }
}

export async function getFileDiff(opts: {
  worktree: string;
  /** Range-aware mode. When provided alongside `taskBaseSha`, computes both sides per range. */
  range?: DiffRange;
  /** Resolved task base SHA (used when range.kind === 'base'). */
  taskBaseSha?: string;
  /** Legacy single-ref mode (used by callers that haven't migrated to ranges). */
  base?: string;
  relPath: string;
}): Promise<FileDiff> {
  const { worktree, relPath } = opts;
  const abs = safeResolvePath(worktree, relPath);

  // Resolve old/new refs from either the range form or the legacy `base` form.
  let oldRef: string;
  let newRef: string | typeof WORKDIR;
  if (opts.range) {
    oldRef = rangeOldRef(opts.range, opts.taskBaseSha ?? '');
    newRef = rangeNewRef(opts.range);
  } else {
    if (!opts.base) throw new Error('getFileDiff requires either `range` or `base`');
    oldRef = opts.base;
    newRef = WORKDIR;
  }

  let oldContent = '';
  try {
    oldContent = await git(worktree, ['show', `${oldRef}:${relPath}`]);
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code !== 128 && !String((err as Error).message).includes('exists on disk')) {
      throw err;
    }
  }

  let newContent = '';
  let tooLarge = false;
  let binary = false;
  let isDirectory = false;
  let newExists = false;
  if (newRef === WORKDIR) {
    if (fs.existsSync(abs)) {
      newExists = true;
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) {
        isDirectory = true;
      } else if (stat.size > MAX_FILE_BYTES) {
        tooLarge = true;
      } else if (stat.isFile()) {
        const buf = await fs.promises.readFile(abs);
        const sniff = buf.subarray(0, Math.min(buf.length, 8192));
        binary = sniff.includes(0);
        if (!binary) newContent = buf.toString('utf8');
      }
    }
  } else {
    try {
      newContent = await git(worktree, ['show', `${newRef}:${relPath}`]);
      newExists = true;
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (code !== 128 && !String((err as Error).message).includes('exists on disk')) {
        throw err;
      }
      // exit 128 from `git show` means the path doesn't exist at that ref.
    }
  }

  let status: FileStatus;
  if (binary) status = 'B';
  else if (!newExists) status = 'D';
  else if (oldContent === '') status = 'A';
  else status = 'M';

  return { oldContent, newContent, status, tooLarge, binary, isDirectory };
}

/**
 * `git diff --name-only base..head` — returns the unique list of files changed
 * between two SHAs in PR-head terms.
 */
export async function listChangedFiles(opts: {
  worktree: string;
  base: string;
  head: string;
}): Promise<string[]> {
  const stdout = await git(opts.worktree, [
    'diff',
    '--name-only',
    '--no-renames',
    `${opts.base}..${opts.head}`,
  ]);
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `git show <sha>:<relPath>` — returns the file contents at a SHA, throws if missing. */
export async function showFileAtSha(opts: {
  worktree: string;
  sha: string;
  relPath: string;
}): Promise<string> {
  return git(opts.worktree, ['show', `${opts.sha}:${opts.relPath}`]);
}

export function safeResolvePath(worktree: string, relPath: string): string {
  if (!relPath || relPath.trim() === '') throw new Error('Invalid path');
  if (path.isAbsolute(relPath)) throw new Error('Invalid path');
  const wtAbs = path.resolve(worktree);
  const resolved = path.resolve(wtAbs, relPath);
  if (resolved !== wtAbs && !resolved.startsWith(wtAbs + path.sep)) {
    throw new Error('Invalid path');
  }
  return resolved;
}
