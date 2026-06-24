import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  BaseBranchMissingError,
  BaseUnavailableError,
  clearDiffBaseCache,
  resolveDiffBase,
} from './diff-base.js';
import type { DiffTarget } from './types.js';

const baseTarget: DiffTarget = {
  id: 't1',
  worktree: '/tmp/wt',
  repo_path: '/tmp/repo',
  run_mode: 'worktree',
  base_branch: null,
  base_sha: 'abc1234567890abcdef1234567890abcdef1234',
};

function target(overrides: Partial<DiffTarget>): DiffTarget {
  return Object.assign({}, baseTarget, overrides);
}

const mockedExec = execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Build an execFile mock that responds to `fetch` and `rev-parse` calls.
 * Pass a sequence of outcomes — each call to the mock pops the next outcome
 * for its command type. An outcome of `'ok'` returns a deterministic SHA;
 * `'err'` rejects with `network down`; `'hang'` never calls back (used to
 * exercise the internal timeout under fake timers).
 */
type Outcome = 'ok' | 'err' | 'hang';
function programExec(outcomes: { fetch: Outcome[]; revParse: Outcome[]; sha?: string }): void {
  const f = [...outcomes.fetch];
  const r = [...outcomes.revParse];
  const sha = outcomes.sha ?? 'deadbeef00112233445566778899aabbccddeeff';
  mockedExec.mockImplementation(
    (
      _cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      const arr = args as string[];
      const which = arr.includes('fetch') ? 'fetch' : arr.includes('rev-parse') ? 'rev' : null;
      const next = which === 'fetch' ? f.shift() : which === 'rev' ? r.shift() : 'ok';
      if (next === 'hang') return undefined;
      if (next === 'err') cb(new Error('network down'), { stdout: '', stderr: '' });
      else if (which === 'rev') cb(null, { stdout: `${sha}\n`, stderr: '' });
      else cb(null, { stdout: '', stderr: '' });
      return undefined;
    },
  );
}

describe('resolveDiffBase', () => {
  beforeEach(() => {
    mockedExec.mockReset();
    clearDiffBaseCache();
  });

  it('returns snapshot SHA when base_branch is null (no live lookup)', async () => {
    const t = target({ base_branch: null, base_sha: 'aaaaaaa1234567890aaaaaaa1234567890aaaaaa' });
    const res = await resolveDiffBase(t);
    expect(res).toEqual({
      sha: 'aaaaaaa1234567890aaaaaaa1234567890aaaaaa',
      ref: 'aaaaaaa',
      is_stale: false,
    });
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('fetches origin/<base_branch> tip on success', async () => {
    programExec({ fetch: ['ok'], revParse: ['ok'] });
    const t = target({ base_branch: 'main' });
    const res = await resolveDiffBase(t);
    expect(res).toEqual({
      sha: 'deadbeef00112233445566778899aabbccddeeff',
      ref: 'origin/main',
      is_stale: false,
    });
  });

  it('coalesces concurrent fetches for the same (cwd, base_branch)', async () => {
    programExec({ fetch: ['ok'], revParse: ['ok'] });
    const t = target({ base_branch: 'main' });
    const [a, b, c] = await Promise.all([
      resolveDiffBase(t),
      resolveDiffBase(t),
      resolveDiffBase(t),
    ]);
    expect(a.sha).toBe(b.sha);
    expect(b.sha).toBe(c.sha);
    // 1 fetch + 1 rev-parse total for 3 concurrent callers.
    const fetchCalls = mockedExec.mock.calls.filter((args) =>
      (args[1] as string[]).includes('fetch'),
    );
    const revCalls = mockedExec.mock.calls.filter((args) =>
      (args[1] as string[]).includes('rev-parse'),
    );
    expect(fetchCalls.length).toBe(1);
    expect(revCalls.length).toBe(1);
  });

  it('serves from cache within 30s without re-fetching', async () => {
    programExec({ fetch: ['ok'], revParse: ['ok'] });
    const t = target({ base_branch: 'main' });
    await resolveDiffBase(t);
    mockedExec.mockClear();
    const res = await resolveDiffBase(t);
    expect(res.sha).toBe('deadbeef00112233445566778899aabbccddeeff');
    expect(res.is_stale).toBe(false);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('retries fetch once on transient failure', async () => {
    programExec({ fetch: ['err', 'ok'], revParse: ['ok'] });
    const t = target({ base_branch: 'main' });
    const res = await resolveDiffBase(t);
    expect(res.is_stale).toBe(false);
    expect(res.sha).toBe('deadbeef00112233445566778899aabbccddeeff');
  });

  it('serves expired cache marked stale when all retries fail', async () => {
    // First call: populate cache with sha X.
    programExec({
      fetch: ['ok'],
      revParse: ['ok'],
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const t = target({ base_branch: 'main' });
    const first = await resolveDiffBase(t);
    expect(first.sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Expire the cache, then make all attempts fail.
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);
    programExec({ fetch: ['err', 'err'], revParse: [] });

    // Skip past the retry backoff (200ms) without waiting wall-clock.
    const promise = resolveDiffBase(t);
    await vi.advanceTimersByTimeAsync(500);
    const res = await promise;
    vi.useRealTimers();

    expect(res.is_stale).toBe(true);
    expect(res.sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.ref).toBe('origin/main');
  });

  it('throws BaseUnavailableError when no cache + all fetch attempts fail', async () => {
    programExec({ fetch: ['err', 'err'], revParse: [] });
    const t = target({ base_branch: 'main' });
    vi.useFakeTimers();
    const promise = resolveDiffBase(t).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    const err = await promise;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(BaseUnavailableError);
    expect((err as Error).message).toMatch(/origin\/main/);
  });

  it('throws BaseUnavailableError when rev-parse returns empty stdout and no cache', async () => {
    // empty stdout on rev-parse → "empty rev-parse output" → retried once → still empty → throw
    programExec({ fetch: ['ok', 'ok'], revParse: ['err', 'err'] });
    // Simulate empty stdout instead of error by tweaking the mock directly.
    mockedExec.mockReset();
    mockedExec.mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const arr = args as string[];
        if (arr.includes('fetch')) cb(null, { stdout: '', stderr: '' });
        else if (arr.includes('rev-parse')) cb(null, { stdout: '\n', stderr: '' });
        return undefined;
      },
    );

    const t = target({
      base_branch: 'main',
      base_sha: 'cafebabe1234567890cafebabe1234567890cafe',
    });
    vi.useFakeTimers();
    const promise = resolveDiffBase(t).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    const err = await promise;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(BaseUnavailableError);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('falls back to BaseUnavailableError when fetch hangs past timeout (no cache)', async () => {
      mockedExec.mockImplementation(() => {
        // Don't call cb — simulate hang. withTimeout fires internal timeout.
        return undefined;
      });
      const t = target({ base_branch: 'main' });
      const promise = resolveDiffBase(t).catch((e) => e);
      // Internal per-attempt timeout = ATTEMPT_TIMEOUT_MS (5000) - 250 = 4750ms.
      // Two attempts + 200ms backoff ⇒ advance ~10s to drain.
      await vi.advanceTimersByTimeAsync(10000);
      const err = await promise;
      expect(err).toBeInstanceOf(BaseUnavailableError);
    });
  });

  describe('local base branch fallback (ref absent on origin)', () => {
    // git fetch error when the branch exists locally but was never pushed.
    const MISSING_REF_ERR = "fatal: couldn't find remote ref featureX";

    it('resolves the local branch tip when origin has no such ref', async () => {
      const localSha = '1111111111111111111111111111111111111111';
      mockedExec.mockImplementation(
        (
          _cmd: string,
          args: readonly string[],
          _opts: unknown,
          cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
        ) => {
          const arr = args as string[];
          if (arr.includes('fetch')) {
            cb(new Error(MISSING_REF_ERR), { stdout: '', stderr: MISSING_REF_ERR });
          } else if (arr.includes('rev-parse')) {
            // Only the local lookup (refs/heads/...) should be reached.
            if (arr.some((a) => a.startsWith('refs/heads/'))) {
              cb(null, { stdout: `${localSha}\n`, stderr: '' });
            } else {
              cb(new Error('origin rev-parse should not run'), { stdout: '', stderr: '' });
            }
          }
          return undefined;
        },
      );

      const t = target({ base_branch: 'featureX' });
      const res = await resolveDiffBase(t);
      expect(res).toEqual({ sha: localSha, ref: 'featureX', is_stale: false });

      // Deterministic failure — must NOT retry the fetch.
      const fetchCalls = mockedExec.mock.calls.filter((c) => (c[1] as string[]).includes('fetch'));
      expect(fetchCalls.length).toBe(1);
    });

    it('throws BaseBranchMissingError when the branch is absent on origin AND locally', async () => {
      mockedExec.mockImplementation(
        (
          _cmd: string,
          args: readonly string[],
          _opts: unknown,
          cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
        ) => {
          const arr = args as string[];
          if (arr.includes('fetch')) {
            cb(new Error(MISSING_REF_ERR), { stdout: '', stderr: MISSING_REF_ERR });
          } else if (arr.includes('rev-parse')) {
            // Local lookup also fails (branch gone everywhere).
            cb(new Error('not a valid ref'), { stdout: '', stderr: '' });
          }
          return undefined;
        },
      );

      const t = target({ base_branch: 'featureX' });
      const err = (await resolveDiffBase(t).catch((e) => e)) as Error & { code?: string };
      expect(err).toBeInstanceOf(BaseBranchMissingError);
      expect(err.code).toBe('base_branch_missing');
      expect(err.message).toMatch(/featureX/);
    });
  });

  it('clearDiffBaseCache invalidates the cache for that key', async () => {
    programExec({ fetch: ['ok', 'ok'], revParse: ['ok', 'ok'], sha: 'a'.repeat(40) });
    const t = target({ base_branch: 'main' });
    const first = await resolveDiffBase(t);
    expect(first.sha).toBe('a'.repeat(40));

    clearDiffBaseCache(t.worktree as string, 'main');

    // Re-program with a new SHA — should now re-fetch instead of hitting cache.
    programExec({ fetch: ['ok'], revParse: ['ok'], sha: 'b'.repeat(40) });
    const second = await resolveDiffBase(t);
    expect(second.sha).toBe('b'.repeat(40));
  });
});
