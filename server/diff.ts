import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';

const execFile = promisify(execFileCb);
const logger = childLogger('diff');

export const MAX_FILE_BYTES = 1_048_576; // 1 MiB

export type FileStatus = 'A' | 'M' | 'D' | 'B';

export interface DiffFileEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  files: DiffFileEntry[];
}

export interface FileDiff {
  oldContent: string;
  newContent: string;
  status: FileStatus;
  tooLarge: boolean;
  binary: boolean;
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
  worktree: string;
  base: string;
}): Promise<DiffSummary> {
  const { worktree, base } = opts;

  let committedNumstat = '';
  try {
    committedNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', `${base}...HEAD`]);
  } catch (err) {
    logger.warn(
      { worktree, base, err: (err as Error).message },
      'three-dot diff failed, falling back',
    );
    committedNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', `${base}..HEAD`]);
  }
  const committed = parseNumstat(committedNumstat);

  const committedNameStatus = await git(worktree, [
    'diff',
    '--name-status',
    '--no-renames',
    `${base}...HEAD`,
  ]).catch(() => git(worktree, ['diff', '--name-status', '--no-renames', `${base}..HEAD`]));
  const committedStatus = new Map<string, 'A' | 'M' | 'D'>();
  for (const line of committedNameStatus.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p) continue;
    committedStatus.set(p, (code[0] as 'A' | 'M' | 'D') || 'M');
  }

  const workingNumstat = await git(worktree, ['diff', '--numstat', '--no-renames', 'HEAD']);
  const working = parseNumstat(workingNumstat);

  const porcelain = await git(worktree, ['status', '--porcelain=v1', '--no-renames']);
  const untrackedPaths: string[] = [];
  const deleted = new Set<string>();
  for (const line of porcelain.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3);
    if (code === '??') untrackedPaths.push(p);
    if (code.includes('D')) deleted.add(p);
  }

  const paths = new Set<string>([...committed.keys(), ...working.keys(), ...untrackedPaths]);

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

    files.push({ path: p, status, additions, deletions });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

export async function getFileDiff(opts: {
  worktree: string;
  base: string;
  relPath: string;
}): Promise<FileDiff> {
  const { worktree, base, relPath } = opts;
  const abs = safeResolvePath(worktree, relPath);

  let oldContent = '';
  try {
    oldContent = await git(worktree, ['show', `${base}:${relPath}`]);
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code !== 128 && !String((err as Error).message).includes('exists on disk')) {
      throw err;
    }
  }

  let newContent = '';
  let tooLarge = false;
  let binary = false;
  if (fs.existsSync(abs)) {
    const stat = await fs.promises.stat(abs);
    if (stat.size > MAX_FILE_BYTES) {
      tooLarge = true;
    } else {
      const buf = await fs.promises.readFile(abs);
      const sniff = buf.subarray(0, Math.min(buf.length, 8192));
      binary = sniff.includes(0);
      if (!binary) newContent = buf.toString('utf8');
    }
  }

  let status: FileStatus;
  if (binary) status = 'B';
  else if (!fs.existsSync(abs)) status = 'D';
  else if (oldContent === '') status = 'A';
  else status = 'M';

  return { oldContent, newContent, status, tooLarge, binary };
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
