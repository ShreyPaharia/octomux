/**
 * server/artifact-files.ts
 *
 * `ctx.artifacts` file backend: plugin-written files land in the task's
 * worktree under `.octomux/artifacts/<pluginId>/<name>`, next to the
 * narrative `.octomux/artifact.md`. Same as that file, these land in the
 * task's git worktree and therefore show up in the task diff — deliberate,
 * not an oversight: they survive a DB wipe and they diff like everything
 * else under `.octomux/`.
 *
 * `index.json` at `.octomux/artifacts/index.json` carries the metadata
 * (`{ "<pluginId>/<name>": { pluginId, name, mime, size, updatedAt } }`).
 * An index is necessary because `mime` is not recoverable from the
 * filesystem — deriving it from the file extension would silently lie
 * about what the plugin declared.
 */
// DEPENDENCY-FREE BY DESIGN, same discipline as ./artifact.ts: fs/path/os
// only, no `db`, no `repositories`. The taskId-resolving wrapper lives in
// ./artifact-task.ts.
import fs from 'fs';
import path from 'path';
import os from 'os';

const ARTIFACTS_REL_DIR = path.join('.octomux', 'artifacts');
const INDEX_FILE = 'index.json';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
// ponytail: 5 MB ceiling on an in-memory string body. Upgrade path if plugins
// start writing large binaries: stream to disk instead of buffering the
// whole body, and/or cap total bytes per task.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface ArtifactRecord {
  pluginId: string;
  name: string;
  mime: string;
  size: number;
  updatedAt: string;
}

type Index = Record<string, ArtifactRecord>;

/** UTC timestamp in sqlite `datetime('now')` shape — see ./artifact.ts's copy. */
function sqliteTimestamp(d: Date = new Date()): string {
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

function assertValidSegment(kind: 'pluginId' | 'name', value: string): void {
  if (!NAME_RE.test(value)) {
    throw new Error(`invalid artifact ${kind}: ${JSON.stringify(value)}`);
  }
}

function assertValidMime(mime: string): void {
  if (!MIME_RE.test(mime)) {
    throw new Error(`invalid artifact mime: ${JSON.stringify(mime)}`);
  }
}

function artifactsDir(worktree: string): string {
  return path.join(worktree, ARTIFACTS_REL_DIR);
}

function indexPath(worktree: string): string {
  return path.join(artifactsDir(worktree), INDEX_FILE);
}

/** Belt-and-braces: resolve the body path and assert it still lands inside
 *  `<worktree>/.octomux/artifacts/`, even though the regex above already
 *  rejects `..`, `/`, `\` and empty segments. */
function bodyPath(worktree: string, pluginId: string, name: string): string {
  const dir = artifactsDir(worktree);
  const file = path.join(dir, pluginId, name);
  const resolvedDir = path.resolve(dir) + path.sep;
  const resolvedFile = path.resolve(file);
  if (!resolvedFile.startsWith(resolvedDir)) {
    throw new Error(`artifact path escapes artifacts dir: ${JSON.stringify(file)}`);
  }
  return file;
}

function readIndex(worktree: string): Index {
  try {
    const raw = fs.readFileSync(indexPath(worktree), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Index) : {};
  } catch {
    return {};
  }
}

/** Atomic write: temp file then rename (same discipline as ./artifact.ts). */
function writeIndex(worktree: string, index: Index): void {
  const dir = artifactsDir(worktree);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    os.tmpdir(),
    `octomux-artifacts-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, indexPath(worktree));
}

/**
 * Writes (or overwrites) one artifact. The index read-modify-write below is
 * synchronous within this call, so there is no intra-process race.
 *
 * ponytail: a second octomux process writing the same worktree's artifacts
 * concurrently could still interleave read-modify-write across processes —
 * a lockfile is the upgrade path if that ever becomes real.
 */
export function writeArtifact(
  worktree: string,
  pluginId: string,
  input: { name: string; mime: string; body: string },
): ArtifactRecord {
  assertValidSegment('pluginId', pluginId);
  assertValidSegment('name', input.name);
  assertValidMime(input.mime);
  if (typeof input.body !== 'string') {
    throw new Error('artifact body must be a string');
  }
  const size = Buffer.byteLength(input.body, 'utf8');
  if (size > MAX_BODY_BYTES) {
    throw new Error(`artifact body too large: ${size} bytes exceeds ${MAX_BODY_BYTES} byte limit`);
  }

  const file = bodyPath(worktree, pluginId, input.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    os.tmpdir(),
    `octomux-artifact-body-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmp, input.body, 'utf8');
  fs.renameSync(tmp, file);

  const record: ArtifactRecord = {
    pluginId,
    name: input.name,
    mime: input.mime,
    size,
    updatedAt: sqliteTimestamp(),
  };
  const index = readIndex(worktree);
  index[`${pluginId}/${input.name}`] = record;
  writeIndex(worktree, index);
  return record;
}

/**
 * Every artifact across every plugin, sorted by pluginId then name. Never
 * throws — returns `[]` for a missing worktree, missing artifacts dir, or a
 * corrupt/unparseable index.json. Drops index entries whose body file no
 * longer exists on disk (someone `rm`'d it, or the worktree got cleaned), so
 * disk stays the source of truth.
 */
export function listArtifacts(worktree: string): ArtifactRecord[] {
  const index = readIndex(worktree);
  const records = Object.values(index).filter((rec) => {
    try {
      return fs.existsSync(bodyPath(worktree, rec.pluginId, rec.name));
    } catch {
      // A hand-edited/corrupt index.json entry that resolves outside the
      // artifacts dir — never throw out of a read path, just drop it.
      return false;
    }
  });
  records.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.name.localeCompare(b.name));
  return records;
}

/** Reads one artifact's record + body. `null` when the index has no such key
 *  or the body file is gone. */
export function readArtifact(
  worktree: string,
  pluginId: string,
  name: string,
): { record: ArtifactRecord; body: string } | null {
  const index = readIndex(worktree);
  const record = index[`${pluginId}/${name}`];
  if (!record) return null;
  try {
    const body = fs.readFileSync(bodyPath(worktree, pluginId, name), 'utf8');
    return { record, body };
  } catch {
    return null;
  }
}
