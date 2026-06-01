import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from './logger.js';
import type { Task } from './types.js';

const execFile = promisify(execFileCb);
const logger = childLogger('diff-base');

export interface ResolvedBase {
  /** Full SHA of the resolved base. */
  sha: string;
  /** Human-readable ref (e.g. `origin/main` for live; short SHA for fallback). */
  ref: string;
  /** True when we couldn't reach origin and are serving an expired cache entry. */
  is_stale: boolean;
}

/**
 * Thrown by `resolveDiffBase` when a task has a `base_branch` but we couldn't
 * reach origin AND have no cached SHA from a previous successful resolution.
 * Callers should surface this to the UI as a transient "diff base unavailable"
 * state — distinct from "task has no base_sha at all" (400) because retrying
 * later may succeed.
 */
export class BaseUnavailableError extends Error {
  readonly code = 'base_unavailable' as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'BaseUnavailableError';
  }
}

/**
 * Thrown by `resolveDiffBase` when a task's `base_branch` exists neither on
 * origin nor as a local branch — it has been deleted everywhere. Distinct from
 * `BaseUnavailableError` (origin unreachable, retrying may help): this is a
 * definite missing-ref state, so the UI should say so plainly rather than
 * implying a transient network problem.
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
 * on origin (vs. a network/connectivity failure). Deterministic, so we don't
 * retry it — we fall back to the local branch instead.
 */
class RemoteRefMissingError extends Error {}

// `git fetch origin <branch>` prints this to stderr when the ref is absent on
// origin. Reachability is fine — the branch simply isn't there (e.g. a
// local-only or never-pushed base branch).
function isMissingRemoteRef(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string };
  const text = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return /couldn't find remote ref/i.test(text);
}

const CACHE_TTL_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 5_000;
// Internal promise-level timeout fires slightly before the execFile timeout
// so the wrapper wins deterministically (e.g. when execFile is mocked in tests
// and never resolves, or in production if child kill is delayed).
const ATTEMPT_INTERNAL_MS = ATTEMPT_TIMEOUT_MS - 250;
const RETRY_ATTEMPTS = 2; // initial + 1 retry
const RETRY_BACKOFF_MS = 200;

interface CacheEntry {
  sha: string;
  ts: number;
  /** Human-readable ref this SHA resolved to (`origin/<x>` live, `<x>` local). */
  ref: string;
}

interface ResolvedLive {
  sha: string;
  ref: string;
}

// Keyed by `${cwd}\0${base_branch}` — `cwd` is each task's worktree (unique
// per task) or its repo_path (shared across `none`-mode tasks).
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ResolvedLive>>();

function cacheKey(cwd: string, baseBranch: string): string {
  return `${cwd}\0${baseBranch}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
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

/**
 * Promise-level timeout wrapper. Node's `execFile` honours its own `timeout`
 * option in production by killing the child, but our tests mock `execFile`
 * without ever invoking the callback — so we also race against an internal
 * timer to guarantee the helper resolves promptly. The internal timer fires
 * slightly *before* the execFile timeout so the wrapper deterministically wins
 * in tests (where the mocked child is never killed).
 */
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
    // Ref absent on origin is deterministic — surface it distinctly so the
    // caller can fall back to the local branch instead of retrying.
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
      // Missing-on-origin is deterministic; retrying can't help.
      if (err instanceof RemoteRefMissingError) throw err;
      lastErr = err as Error;
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

/**
 * Resolve a base branch that exists locally but not on origin (e.g. preserved,
 * recovered, or not-yet-pushed branches). Returns the local tip SHA, or null if
 * there's no such local branch either.
 */
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

/**
 * Resolve the live base SHA + ref, preferring `origin/<base_branch>`. If origin
 * has no such ref, fall back to the local branch. Throws `BaseBranchMissingError`
 * when the branch is gone everywhere, or re-throws a network-class error (which
 * the caller maps to stale-cache / `BaseUnavailableError`).
 */
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

/**
 * Resolve the base commit a task's diff should compute against.
 *
 *  - `base_branch` is null/missing → snapshot SHA, `is_stale = false`
 *    (none/scratch modes that never tracked a branch).
 *  - `base_branch` set → live tip of `origin/<base_branch>`, with a 30s
 *    in-process cache keyed by (cwd, base_branch). Concurrent requests are
 *    coalesced onto a single in-flight fetch.
 *  - Cache miss + fetch fails (after retry) → serve expired cache entry
 *    if one exists (`is_stale = true`); otherwise throw `BaseUnavailableError`.
 *
 * Rationale: `task.base_sha` stored at task creation goes stale after rebases
 * (the DB column isn't updated), so for live diff display we always prefer
 * origin tip.
 */
export async function resolveDiffBase(task: Task): Promise<ResolvedBase> {
  if (!task.base_branch || !task.worktree) {
    return {
      sha: task.base_sha ?? '',
      ref: task.base_sha ? shortSha(task.base_sha) : '',
      is_stale: false,
    };
  }

  const cwd = task.worktree;
  const baseBranch = task.base_branch;
  const key = cacheKey(cwd, baseBranch);
  const now = Date.now();
  const entry = cache.get(key);

  // Fresh cache hit.
  if (entry && now - entry.ts < CACHE_TTL_MS) {
    return { sha: entry.sha, ref: entry.ref, is_stale: false };
  }

  // Coalesce concurrent resolutions for the same (cwd, base_branch).
  let p = pending.get(key);
  if (!p) {
    p = resolveLive(cwd, baseBranch).then(
      (resolved) => {
        cache.set(key, { sha: resolved.sha, ts: Date.now(), ref: resolved.ref });
        return resolved;
      },
      (err: Error) => {
        // Re-throw so awaiting callers see the failure; cache untouched.
        throw err;
      },
    );
    pending.set(key, p);
    // Detach cleanup so we don't accidentally swallow rejections.
    p.finally(() => {
      if (pending.get(key) === p) pending.delete(key);
    }).catch(() => {});
  }

  try {
    const resolved = await p;
    return { sha: resolved.sha, ref: resolved.ref, is_stale: false };
  } catch (err) {
    // Branch deleted everywhere — definite, not a connectivity blip.
    if (err instanceof BaseBranchMissingError) throw err;
    if (entry) {
      logger.warn(
        {
          task_id: task.id,
          base_branch: baseBranch,
          age_ms: now - entry.ts,
          err: (err as Error).message,
        },
        'live-base resolution failed, serving expired cache',
      );
      return { sha: entry.sha, ref: entry.ref, is_stale: true };
    }
    logger.warn(
      { task_id: task.id, base_branch: baseBranch, err: (err as Error).message },
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
 * clear a single entry (e.g. after the user mutates the task's base), or call
 * with no args to clear everything (tests).
 */
export function clearDiffBaseCache(cwd?: string, baseBranch?: string): void {
  if (cwd && baseBranch) {
    cache.delete(cacheKey(cwd, baseBranch));
    return;
  }
  cache.clear();
  pending.clear();
}
