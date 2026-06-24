import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { resolveDiffBase } from './diff-base.js';
import { gitEnv } from './git-env.js';
import { targetWorkingDir } from './target-paths.js';
import {
  WORKDIR,
  rangeIncludesWorkingTree,
  rangeNameStatusArgs,
  rangeNewRef,
  rangeNumstatArgs,
  rangeOldRef,
} from './diff-range.js';
import type { DiffLogger, DiffRange, DiffTarget } from './types.js';
import { noopLogger } from './types.js';

const execFile = promisify(execFileCb);

export const MAX_FILE_BYTES = 1_048_576; // 1 MiB
export const MAX_IGNORED_FILES = 200;

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
}

export interface DiffSummary {
  files: DiffFileEntry[];
  ignoredTruncated?: boolean;
  base_sha: string;
  base_ref: string;
  base_is_stale: boolean;
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

export interface GetDiffSummaryOptions {
  target: DiffTarget;
  range?: DiffRange;
  logger?: DiffLogger;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

export async function hashObject(worktree: string, relPath: string): Promise<string | null> {
  try {
    const sha = (await git(worktree, ['hash-object', '--', relPath])).trim();
    return sha || null;
  } catch {
    return null;
  }
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

export async function getDiffSummary(opts: GetDiffSummaryOptions): Promise<DiffSummary> {
  const { target, range = { kind: 'base' as const }, logger = noopLogger } = opts;
  const worktree = targetWorkingDir(target);
  if (!worktree) throw new Error('Task has no worktree');

  const resolved = await resolveDiffBase(target, { logger });
  const base = resolved.sha;

  const numstatArgs = rangeNumstatArgs(range, base);
  const committed = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const committedStatus = new Map<string, 'A' | 'M' | 'D'>();
  if (numstatArgs) {
    let committedNumstat = '';
    try {
      committedNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', ...numstatArgs]);
    } catch (err) {
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

  const includeWorking = rangeIncludesWorkingTree(range);
  const working = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const untrackedPaths: string[] = [];
  const deleted = new Set<string>();
  if (includeWorking) {
    const workingNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', 'HEAD']);
    for (const [p, v] of parseNumstat(workingNumstat)) working.set(p, v);

    const porcelain = await git(worktree, ['status', '--porcelain=v1', '--no-renames', '-uall']);
    for (const line of porcelain.split('\n')) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3);
      if (!p || p.endsWith('/')) continue;
      if (code === '??') untrackedPaths.push(p);
      if (code.includes('D')) deleted.add(p);
    }
  }

  const paths = new Set<string>([...committed.keys(), ...working.keys(), ...untrackedPaths]);

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

    let post_blob_sha: string | null;
    if (status === 'D') {
      post_blob_sha = null;
    } else if (includeWorking) {
      post_blob_sha = existsOnDisk ? await hashObject(worktree, p) : null;
    } else {
      post_blob_sha =
        newRefForBlob == null
          ? null
          : await blobAt({ worktree, commit: newRefForBlob, relPath: p });
    }
    files.push({ path: p, status, additions, deletions, post_blob_sha });
  }

  const summary: DiffSummary = {
    files,
    base_sha: resolved.sha,
    base_ref: resolved.ref,
    base_is_stale: resolved.is_stale,
    total_count: files.filter((f) => !f.ignored).length,
  };

  if (range.kind === 'base') {
    await appendIgnoredFiles(summary, { worktree, knownPaths: paths, logger });
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
  opts: { worktree: string; knownPaths: Set<string>; logger: DiffLogger },
): Promise<void> {
  const { worktree, knownPaths, logger } = opts;

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
  range?: DiffRange;
  taskBaseSha?: string;
  base?: string;
  relPath: string;
}): Promise<FileDiff> {
  const { worktree, relPath } = opts;
  const abs = safeResolvePath(worktree, relPath);

  let oldRef: string;
  let newRef: string | typeof WORKDIR;
  if (opts.range) {
    oldRef = rangeOldRef(opts.range, opts.taskBaseSha ?? '');
    newRef = rangeIncludesWorkingTree(opts.range) ? WORKDIR : rangeNewRef(opts.range);
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
    }
  }

  let status: FileStatus;
  if (binary) status = 'B';
  else if (!newExists) status = 'D';
  else if (oldContent === '') status = 'A';
  else status = 'M';

  return { oldContent, newContent, status, tooLarge, binary, isDirectory };
}

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
