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
  it('returns ok=true when current branch matches target and no other tasks', async () => {
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
      warnings: [],
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

  it('treats same-branch active none task as a non-blocking warning', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
       VALUES ('wt1', '/repo', '/repo', 'feature-x', 'feature-x', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('t1', 'Other chat', '', 'running', 'wt1')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref'))
        return Promise.resolve({ stdout: 'feature-x\n', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([
      { task_id: 't1', title: 'Other chat', runtime_state: 'running', branch: 'feature-x' },
    ]);
  });

  it('treats different-branch active none task as a blocking conflict', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
       VALUES ('wt-main', '/repo', '/repo', 'main', 'main', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('t-main', 'main task', '', 'running', 'wt-main')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) return Promise.resolve({ stdout: '', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([
      { task_id: 't-main', title: 'main task', runtime_state: 'running', branch: 'main' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('skips closed tasks and ignores new-mode worktree tasks', async () => {
    const db = getDb();
    // closed none-mode task → ignored
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wt-closed', '/repo', '/repo', 'feature-x', 'none', 'available')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('closed1', 'closed', '', 'idle', 'wt-closed')`,
    ).run();
    // active 'new'-mode task on the same branch → ignored (its own worktree)
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wt-new', '/repo/.worktrees/x', '/repo', 'feature-x', 'new', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('new1', 'new wt task', '', 'running', 'wt-new')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref'))
        return Promise.resolve({ stdout: 'feature-x\n', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('with excludeTaskId, skips the caller’s own row even when its branch is null', async () => {
    const db = getDb();
    // Caller's own row — w.branch is null until setupNone finishes.
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
       VALUES ('wt-self', '/repo', '/repo', NULL, 'main', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('self', 'me', '', 'setting_up', 'wt-self')`,
    ).run();

    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) return Promise.resolve({ stdout: '', stderr: '' });
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'main', 'self');

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips dirty check while a different-branch conflict is present', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, mode, status)
       VALUES ('wt-main', '/repo', '/repo', 'main', 'none', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('t-main', 'main task', '', 'running', 'wt-main')`,
    ).run();

    let porcelainCalled = false;
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'main\n', stderr: '' });
      if (args.includes('--porcelain=v1')) {
        porcelainCalled = true;
        return Promise.resolve({ stdout: ' M a.ts\n', stderr: '' });
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'feature-x');

    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.dirty).toBeNull();
    expect(porcelainCalled).toBe(false);
  });
});
