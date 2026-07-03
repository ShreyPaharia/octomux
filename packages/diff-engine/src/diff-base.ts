import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { gitEnv } from './git-env.js';
import type { DiffLogger, DiffTarget } from './types.js';
import { noopLogger } from './types.js';

const execFile = promisify(execFileCb);

export interface ResolvedBase {
  /** Full SHA of the resolved base. */
  sha: string;
  /** Human-readable ref (e.g. `origin/main` for live; short SHA for fallback). */
  ref: string;
  /** True when we couldn't reach origin and are serving an expired cache entry. */
  is_stale: boolean;
}

/**
 * Thrown by `resolveDiffBase` when a target has a `base_branch` but we couldn't
 * reach origin AND have no cached SHA from a previous successful resolution.
 */
export class BaseUnavailableError extends Error {
  readonly code = 'base_unavailable' as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'BaseUnavailableError';
  }
}

/**
 * Thrown by `resolveDiffBase` when a target's `base_branch` exists neither on
 * origin nor as a local branch.
 */
export class BaseBranchMissingError extends Error {
  readonly code = 'base_branch_missing' as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'BaseBranchMissingError';
  }
}

/**
 * Internal sentinel: `git fetch origin <branch>` reported the ref doesn't exist
 * on origin (vs. a network/connectivity failure).
 */
class RemoteRefMissingError extends Error {}

function isMissingRemoteRef(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string };
  const text = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return /couldn't find remote ref/i.test(text);
}

const CACHE_TTL_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 5_000;
const ATTEMPT_INTERNAL_MS = ATTEMPT_TIMEOUT_MS - 250;
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 200;

interface CacheEntry {
  sha: string;
  ts: number;
  ref: string;
}

interface ResolvedLive {
  sha: string;
  ref: string;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ResolvedLive>>();

function cacheKey(cwd: string, baseBranch: string): string {
  return `${cwd}\0${baseBranch}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

async function fetchOnce(cwd: string, baseBranch: string): Promise<string> {
  try {
    await withTimeout(
      execFile('git', ['-C', cwd, 'fetch', 'origin', baseBranch], {
        env: gitEnv(),
        timeout: ATTEMPT_TIMEOUT_MS,
      }),
      ATTEMPT_INTERNAL_MS,
      'git fetch',
    );
  } catch (err) {
    if (isMissingRemoteRef(err)) {
      throw new RemoteRefMissingError(`origin has no ref ${baseBranch}`);
    }
    throw err;
  }
  const { stdout } = await withTimeout(
    execFile('git', ['-C', cwd, 'rev-parse', `origin/${baseBranch}`], {
      env: gitEnv(),
      timeout: ATTEMPT_TIMEOUT_MS,
    }),
    ATTEMPT_INTERNAL_MS,
    'git rev-parse',
  );
  const sha = stdout.trim();
  if (!sha) throw new Error('empty rev-parse output');
  return sha;
}

async function fetchWithRetry(cwd: string, baseBranch: string): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(cwd, baseBranch);
    } catch (err) {
      if (err instanceof RemoteRefMissingError) throw err;
      lastErr = err as Error;
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

async function resolveLocalBranch(cwd: string, baseBranch: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`],
      { env: gitEnv() },
    );
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

async function resolveLive(cwd: string, baseBranch: string): Promise<ResolvedLive> {
  try {
    const sha = await fetchWithRetry(cwd, baseBranch);
    return { sha, ref: `origin/${baseBranch}` };
  } catch (err) {
    if (err instanceof RemoteRefMissingError) {
      const localSha = await resolveLocalBranch(cwd, baseBranch);
      if (localSha) return { sha: localSha, ref: baseBranch };
      throw new BaseBranchMissingError(
        `base branch '${baseBranch}' not found on origin or locally`,
      );
    }
    throw err;
  }
}

export interface ResolveDiffBaseOptions {
  logger?: DiffLogger;
}

/**
 * Resolve the base commit a diff should compute against.
 */
export async function resolveDiffBase(
  target: DiffTarget,
  options: ResolveDiffBaseOptions = {},
): Promise<ResolvedBase> {
  const logger = options.logger ?? noopLogger;

  if (!target.base_branch || !target.worktree) {
    return {
      sha: target.base_sha ?? '',
      ref: target.base_sha ? shortSha(target.base_sha) : '',
      is_stale: false,
    };
  }

  const cwd = target.worktree;
  const baseBranch = target.base_branch;
  const key = cacheKey(cwd, baseBranch);
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && now - entry.ts < CACHE_TTL_MS) {
    return { sha: entry.sha, ref: entry.ref, is_stale: false };
  }

  let p = pending.get(key);
  if (!p) {
    p = resolveLive(cwd, baseBranch).then(
      (resolved) => {
        cache.set(key, { sha: resolved.sha, ts: Date.now(), ref: resolved.ref });
        return resolved;
      },
      (err: Error) => {
        throw err;
      },
    );
    pending.set(key, p);
    p.finally(() => {
      if (pending.get(key) === p) pending.delete(key);
    }).catch(() => {});
  }

  try {
    const resolved = await p;
    return { sha: resolved.sha, ref: resolved.ref, is_stale: false };
  } catch (err) {
    if (err instanceof BaseBranchMissingError) throw err;
    if (entry) {
      logger.warn(
        {
          task_id: target.id,
          base_branch: baseBranch,
          age_ms: now - entry.ts,
          err: (err as Error).message,
        },
        'live-base resolution failed, serving expired cache',
      );
      return { sha: entry.sha, ref: entry.ref, is_stale: true };
    }
    logger.warn(
      { task_id: target.id, base_branch: baseBranch, err: (err as Error).message },
      'live-base resolution failed, no cache available',
    );
    throw new BaseUnavailableError(
      `could not resolve origin/${baseBranch}: ${(err as Error).message}`,
    );
  }
}

/**
 * Resolve a user-supplied ref (branch name, `origin/<x>`, raw SHA, or tag) to a
 * full commit SHA in `cwd`. Throws if the ref doesn't resolve.
 */
export async function resolveRef(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', `${ref}^{commit}`], {
    env: gitEnv(),
  });
  const sha = stdout.trim();
  if (!sha) throw new Error(`empty rev-parse output for ${ref}`);
  return sha;
}

/**
 * Invalidate the in-process resolved-base cache. Pass (cwd, baseBranch) to
 * clear a single entry, or call with no args to clear everything (tests).
 */
export function clearDiffBaseCache(cwd?: string, baseBranch?: string): void {
  if (cwd && baseBranch) {
    cache.delete(cacheKey(cwd, baseBranch));
    return;
  }
  cache.clear();
  pending.clear();
}
