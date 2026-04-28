import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { resolveDiffBase } from './diff-base.js';
import type { Task } from './types.js';

const baseTask: Task = {
  id: 't1',
  worktree: '/tmp/wt',
  base_branch: null,
  base_sha: 'abc1234567890abcdef1234567890abcdef1234',
  // other Task fields filled in via Object.assign by the helper below
} as unknown as Task;

function task(overrides: Partial<Task>): Task {
  return Object.assign({}, baseTask, overrides);
}

const mockedExec = execFile as unknown as ReturnType<typeof vi.fn>;

describe('resolveDiffBase', () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it('returns floor sha not-stale when base_branch is null', async () => {
    const t = task({ base_branch: null, base_sha: 'aaaaaaa1234567890aaaaaaa1234567890aaaaaa' });
    const res = await resolveDiffBase(t);
    expect(res).toEqual({
      sha: 'aaaaaaa1234567890aaaaaaa1234567890aaaaaa',
      ref: 'aaaaaaa',
      is_stale: false,
    });
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('fetches origin/<base_branch> tip on success', async () => {
    mockedExec.mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const arr = args as string[];
        if (arr.includes('fetch')) cb(null, { stdout: '', stderr: '' });
        else if (arr.includes('rev-parse'))
          cb(null, { stdout: 'deadbeef00112233445566778899aabbccddeeff\n', stderr: '' });
        return undefined;
      },
    );

    const t = task({ base_branch: 'main' });
    const res = await resolveDiffBase(t);
    expect(res).toEqual({
      sha: 'deadbeef00112233445566778899aabbccddeeff',
      ref: 'origin/main',
      is_stale: false,
    });
  });

  it('falls back to base_sha and sets is_stale=true on fetch failure', async () => {
    mockedExec.mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const arr = args as string[];
        if (arr.includes('fetch')) cb(new Error('network down'), { stdout: '', stderr: '' });
        return undefined;
      },
    );

    const t = task({ base_branch: 'main', base_sha: 'cafebabe1234567890cafebabe1234567890cafe' });
    const res = await resolveDiffBase(t);
    expect(res).toEqual({
      sha: 'cafebabe1234567890cafebabe1234567890cafe',
      ref: 'cafebab',
      is_stale: true,
    });
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('honours 5s timeout on fetch', async () => {
      mockedExec.mockImplementation(
        (_cmd: string, args: readonly string[], opts: { timeout?: number }) => {
          if ((args as string[]).includes('fetch')) {
            expect(opts.timeout).toBe(5000);
          }
          // Don't call cb — simulate hang. Caller should timeout via the
          // internal withTimeout wrapper (execFile's own timeout never fires
          // because the mocked child is never killed).
          return undefined;
        },
      );

      const t = task({
        base_branch: 'main',
        base_sha: 'cafebabe1234567890cafebabe1234567890cafe',
      });
      const promise = resolveDiffBase(t);
      // Advance past the internal timeout (FETCH_TIMEOUT_MS - 250 = 4750ms).
      await vi.advanceTimersByTimeAsync(4751);
      const res = await promise;
      expect(res.is_stale).toBe(true);
      expect(res.sha).toBe('cafebabe1234567890cafebabe1234567890cafe');
    });
  });

  it('falls back to stale when rev-parse returns empty stdout', async () => {
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

    const t = task({
      base_branch: 'main',
      base_sha: 'cafebabe1234567890cafebabe1234567890cafe',
    });
    const res = await resolveDiffBase(t);
    expect(res.is_stale).toBe(true);
    expect(res.sha).toBe('cafebabe1234567890cafebabe1234567890cafe');
    expect(res.ref).toBe('cafebab');
  });
});
