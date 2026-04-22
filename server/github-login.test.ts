import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, findCallback, execFileOk, execFileFail } from './test-helpers.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout: 'owner-login\n', stderr: '' });
    return undefined as any;
  }),
}));

const { ensureGithubLogin, readGithubLogin, resetGithubLoginCache } =
  await import('./github-login.js');
const { execFile } = await import('child_process');

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(execFile).mockImplementation(execFileOk('owner-login\n') as any);
  delete process.env.OCTOMUX_GITHUB_LOGIN;
  resetGithubLoginCache();
});

afterEach(() => {
  db.close();
  delete process.env.OCTOMUX_GITHUB_LOGIN;
  resetGithubLoginCache();
});

describe('ensureGithubLogin', () => {
  it('calls gh api user on first resolve and caches the login', async () => {
    const login = await ensureGithubLogin();

    expect(login).toBe('owner-login');
    const calls = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'gh');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(['api', 'user', '-q', '.login']);

    // Subsequent resolve uses DB cache — no second shell-out
    resetGithubLoginCache();
    const again = await ensureGithubLogin();
    expect(again).toBe('owner-login');
    const callsAfter = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'gh');
    expect(callsAfter).toHaveLength(1);
  });

  it('honours OCTOMUX_GITHUB_LOGIN env override without shelling out', async () => {
    process.env.OCTOMUX_GITHUB_LOGIN = 'env-login';

    const login = await ensureGithubLogin();

    expect(login).toBe('env-login');
    const calls = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'gh');
    expect(calls).toHaveLength(0);
  });

  it('returns null when gh fails and does not crash', async () => {
    vi.mocked(execFile).mockImplementation(execFileFail('gh not found') as any);

    const login = await ensureGithubLogin();

    expect(login).toBeNull();
  });

  it('returns null when gh returns empty output', async () => {
    vi.mocked(execFile).mockImplementation(execFileOk('') as any);

    const login = await ensureGithubLogin();

    expect(login).toBeNull();
  });
});

describe('readGithubLogin', () => {
  it('returns null before ensureGithubLogin has run', () => {
    expect(readGithubLogin()).toBeNull();
  });

  it('returns env override without touching the DB', () => {
    process.env.OCTOMUX_GITHUB_LOGIN = 'env-login';
    expect(readGithubLogin()).toBe('env-login');
  });

  it('returns the DB-cached login after ensureGithubLogin', async () => {
    await ensureGithubLogin();
    resetGithubLoginCache();
    expect(readGithubLogin()).toBe('owner-login');
  });
});
