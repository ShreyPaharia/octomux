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
  /** True when we couldn't reach origin and fell back to the snapshot SHA. */
  is_stale: boolean;
}

const FETCH_TIMEOUT_MS = 5000;
// Internal promise-level timeout fires slightly before the execFile timeout
// so the wrapper wins deterministically (e.g. when execFile is mocked in tests
// and never resolves, or in production if child kill is delayed).
const INTERNAL_TIMEOUT_MS = FETCH_TIMEOUT_MS - 250;

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
 * in tests (where the mocked child is never killed) and stays under the
 * vitest 5s default test timeout. In production both timers fire near the same
 * instant; either path triggers the catch + fallback below.
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

/**
 * Resolve the base commit a task's diff should compute against.
 *
 * Tri-state behaviour:
 *  - `base_branch` is null/missing → snapshot SHA, `is_stale = false`
 *    (none/scratch modes that never tracked a branch).
 *  - origin fetch + rev-parse succeeds → live tip of `origin/<base_branch>`,
 *    `is_stale = false`.
 *  - fetch or rev-parse fails (network down, branch deleted, etc.) → snapshot
 *    SHA, `is_stale = true` so the UI can warn the user.
 */
export async function resolveDiffBase(task: Task): Promise<ResolvedBase> {
  if (!task.base_branch || !task.base_sha) {
    return {
      sha: task.base_sha ?? '',
      ref: task.base_sha ? shortSha(task.base_sha) : '',
      is_stale: false,
    };
  }

  const cwd = task.worktree;
  if (!cwd) {
    return { sha: task.base_sha, ref: shortSha(task.base_sha), is_stale: false };
  }

  try {
    await withTimeout(
      execFile('git', ['-C', cwd, 'fetch', 'origin', task.base_branch], {
        env: gitEnv(),
        timeout: FETCH_TIMEOUT_MS,
      }),
      INTERNAL_TIMEOUT_MS,
      'git fetch',
    );
    const { stdout } = await withTimeout(
      execFile('git', ['-C', cwd, 'rev-parse', `origin/${task.base_branch}`], {
        env: gitEnv(),
        timeout: FETCH_TIMEOUT_MS,
      }),
      INTERNAL_TIMEOUT_MS,
      'git rev-parse',
    );
    const sha = stdout.trim();
    if (!sha) throw new Error('empty rev-parse output');
    return { sha, ref: `origin/${task.base_branch}`, is_stale: false };
  } catch (err) {
    logger.warn(
      { task_id: task.id, base_branch: task.base_branch, err: (err as Error).message },
      'live-base resolution failed, falling back to base_sha',
    );
    return { sha: task.base_sha, ref: shortSha(task.base_sha), is_stale: true };
  }
}
