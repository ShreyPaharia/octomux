import type { DiffRange } from './types.js';

const SHA_RE = /^[0-9a-f]{4,40}$/i;
const REF_RE = /^[A-Za-z0-9._/-]+$/;

function isValidSha(s: string): boolean {
  return SHA_RE.test(s);
}

function isValidRef(s: string): boolean {
  return REF_RE.test(s);
}

/**
 * Parse a `range=` query value into a DiffRange. Throws on malformed input.
 * Accepted shapes:
 *   undefined | '' | 'base'           → { kind: 'base' }
 *   'working'                          → { kind: 'working' }
 *   'commit:<sha>'                     → { kind: 'commit', sha }
 *   'range:<from>..<to>'               → { kind: 'range', from, to }
 */
export function parseDiffRange(raw: string | undefined | null): DiffRange {
  if (raw == null || raw === '' || raw === 'base') return { kind: 'base' };
  if (raw === 'working') return { kind: 'working' };

  if (raw.startsWith('commit:')) {
    const sha = raw.slice('commit:'.length);
    if (!sha || !isValidSha(sha)) throw new Error(`Invalid range: bad commit sha "${sha}"`);
    return { kind: 'commit', sha };
  }

  if (raw.startsWith('range:')) {
    const rest = raw.slice('range:'.length);
    const idx = rest.indexOf('..');
    if (idx < 0) throw new Error('Invalid range: expected "from..to"');
    const from = rest.slice(0, idx);
    const to = rest.slice(idx + 2);
    if (!from || !to) throw new Error('Invalid range: empty endpoint');
    if (to.includes('..')) throw new Error('Invalid range: too many separators');
    if (!isValidRef(from) || !isValidRef(to)) {
      throw new Error('Invalid range: malformed ref');
    }
    return { kind: 'range', from, to };
  }

  throw new Error(`Invalid range: unknown kind "${raw}"`);
}

/** Sentinel returned by `rangeNewRef` to mean "read from the working tree". */
export const WORKDIR = 'WORKDIR' as const;
export type RangeNewRef = string | typeof WORKDIR;

/** Ref to use as the "old" / pre-image side of the diff. */
export function rangeOldRef(range: DiffRange, taskBaseSha: string): string {
  switch (range.kind) {
    case 'base':
      return taskBaseSha;
    case 'commit':
      return `${range.sha}^`;
    case 'range':
      return range.from;
    case 'working':
      return 'HEAD';
  }
}

/**
 * Ref to use as the "new" / post-image side. `WORKDIR` means read from disk.
 * For `base`, callers normally read disk for working+untracked but use `HEAD`
 * for committed-only operations (e.g. `git show HEAD:<path>`); this returns
 * the committed-only ref (`HEAD`) — see `rangeIncludesWorkingTree` for the
 * additive working-tree merge.
 */
export function rangeNewRef(range: DiffRange): RangeNewRef {
  switch (range.kind) {
    case 'base':
      return 'HEAD';
    case 'commit':
      return range.sha;
    case 'range':
      return range.to;
    case 'working':
      return WORKDIR;
  }
}

/** Args appended to `git diff --numstat --no-renames` for committed numstat. */
export function rangeNumstatArgs(range: DiffRange, taskBaseSha: string): string[] | null {
  switch (range.kind) {
    case 'base':
      return [`${taskBaseSha}...HEAD`];
    case 'commit':
      return [`${range.sha}^..${range.sha}`];
    case 'range':
      return [`${range.from}..${range.to}`];
    case 'working':
      return null;
  }
}

/** Args appended to `git diff --name-status --no-renames` for committed names. */
export function rangeNameStatusArgs(range: DiffRange, taskBaseSha: string): string[] | null {
  return rangeNumstatArgs(range, taskBaseSha);
}

/**
 * True when this range should additively pick up the working tree + untracked
 * files (i.e. file changes not yet committed). Only `base` (the existing
 * behaviour) and `working` should — historical commit ranges should not.
 */
export function rangeIncludesWorkingTree(range: DiffRange): boolean {
  return range.kind === 'base' || range.kind === 'working';
}
