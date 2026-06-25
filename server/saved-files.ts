import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import { repoFilesDir } from './octomux-paths.js';

const logger = childLogger('saved-files');

const MAX_FILE_BYTES = 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.html',
]);

export interface SavedFileEntry {
  path: string;
  size: number;
}

export interface SavedFileDetail {
  path: string;
  content: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and resolve a relative path under `<repo>/.octomux/files/`.
 * Rejects absolute paths, traversal, symlinks, and disallowed extensions.
 */
export function resolveSavedFilePath(
  repoPath: string,
  relPath: string,
): { resolved: string; normalized: string } | { rejected: string } {
  if (path.isAbsolute(relPath)) {
    return { rejected: 'path must be relative, not absolute' };
  }

  const normalized = path.normalize(relPath).split(path.sep).join('/');
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    return { rejected: 'path traversal detected' };
  }
  if (!normalized) {
    return { rejected: 'path is required' };
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      rejected: `extension "${ext}" is not allowed; allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    };
  }

  const root = repoFilesDir(repoPath);
  const segments = normalized.split('/').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        return { rejected: `symlink detected at path component "${segment}"` };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') break;
      throw err;
    }
  }

  const resolved = path.join(root, ...segments);
  const containmentBase = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(containmentBase) && resolved !== root) {
    return { rejected: 'path escapes saved-files directory' };
  }

  return { resolved, normalized };
}

async function walkFiles(dir: string, prefix: string, out: SavedFileEntry[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkFiles(abs, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(abs);
    out.push({ path: rel, size: stat.size });
  }
}

export async function listSavedFiles(repoPath: string): Promise<SavedFileEntry[]> {
  const root = repoFilesDir(repoPath);
  if (!(await exists(root))) return [];
  const files: SavedFileEntry[] = [];
  await walkFiles(root, '', files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getSavedFile(repoPath: string, relPath: string): Promise<SavedFileDetail> {
  const resolution = resolveSavedFilePath(repoPath, relPath);
  if ('rejected' in resolution) {
    throw new Error(resolution.rejected);
  }

  let content: string;
  try {
    content = await fs.promises.readFile(resolution.resolved, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw Object.assign(new Error(`File not found: ${relPath}`), { code: 'ENOENT' });
    }
    throw err;
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES} bytes): ${relPath}`);
  }

  return { path: resolution.normalized, content };
}

export async function putSavedFile(
  repoPath: string,
  relPath: string,
  content: string,
): Promise<SavedFileDetail> {
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error(`Content too large (max ${MAX_FILE_BYTES} bytes)`);
  }

  const resolution = resolveSavedFilePath(repoPath, relPath);
  if ('rejected' in resolution) {
    throw new Error(resolution.rejected);
  }

  await fs.promises.mkdir(path.dirname(resolution.resolved), { recursive: true });
  await fs.promises.writeFile(resolution.resolved, content, 'utf-8');
  logger.info({ repo_path: repoPath, path: resolution.normalized }, 'saved file written');
  return { path: resolution.normalized, content };
}
