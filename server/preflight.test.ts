import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers';
import { getDb } from './db';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: (fn: unknown) => fn };
});

import { execFile } from 'child_process';
import { preflightNoneMode } from './preflight';

const mockedExec = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  createTestDb();
  mockedExec.mockReset();
});

describe('preflightNoneMode', () => {
  it('returns ok=true when current branch matches target and no conflicts', async () => {
    mockedExec.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        return Promise.resolve({ stdout: 'main\n', stderr: '' });
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'main');

    expect(result).toEqual({
      ok: true,
      currentBranch: 'main',
      targetBranch: 'main',
      conflicts: [],
      dirty: null,
    });
  });

  it('returns dirty count when current differs from target and tree is dirty', async () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1'))
        return Promise.resolve({ stdout: ' M a.ts\n?? b.ts\n', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(false);
    expect(result.dirty).toEqual({ count: 2 });
    expect(result.currentBranch).toBe('main');
    expect(result.targetBranch).toBe('feature-x');
  });

  it('returns no dirty when switching but tree is clean', async () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) return Promise.resolve({ stdout: '', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(true);
    expect(result.dirty).toBeNull();
  });

  it('returns conflicts when active task uses the same repo+branch', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
       VALUES ('wt1', '/repo', '/repo', 'feature-x', 'feature-x', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, status, worktree_id)
       VALUES ('t1', 'Other chat', '', 'running', 'wt1')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) return Promise.resolve({ stdout: '', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([
      { task_id: 't1', title: 'Other chat', status: 'running', branch: 'feature-x' },
    ]);
  });

  it('skips closed tasks and tasks on other branches', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wt1', '/repo', '/repo', 'feature-x', 'none', 'available')`,
    ).run();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wt2', '/repo', '/repo', 'main', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, status, worktree_id)
       VALUES ('closed1', 'closed', '', 'closed', 'wt1')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, status, worktree_id)
       VALUES ('main1', 'main task', '', 'running', 'wt2')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) return Promise.resolve({ stdout: '', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.conflicts).toEqual([]);
  });
});
