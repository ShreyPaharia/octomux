import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, DEFAULTS, findExecCall } from '../../test-helpers.js';
import type { Task } from '../../types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (
        args.includes('rev-parse') &&
        args.includes('--verify') &&
        args.some((a) => a.startsWith('refs/heads/'))
      ) {
        // Branch does not exist by default
        cb(new Error('fatal: needed a single revision'), null);
      } else if (
        args.includes('rev-parse') &&
        args.includes('--abbrev-ref') &&
        args.includes('--symbolic-full-name')
      ) {
        cb(null, { stdout: 'origin/main\n', stderr: '' });
      } else if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) {
        cb(null, { stdout: 'true\n', stderr: '' });
      } else if (args.includes('rev-parse') && args.includes('merge-base')) {
        cb(null, { stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
      } else if (args.includes('rev-parse')) {
        cb(null, { stdout: 'abcdef0000000000000000000000000000000000\n', stderr: '' });
      } else if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        cb(null, { stdout: '', stderr: '' });
      } else if (args.includes('merge-base')) {
        cb(null, { stdout: '1111111111111111111111111111111111111111\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

vi.mock('../../preflight.js', () => ({
  preflightNoneMode: vi.fn().mockResolvedValue({
    ok: true,
    currentBranch: 'main',
    targetBranch: 'main',
    conflicts: [],
    warnings: [],
    dirty: null,
  }),
}));

vi.mock('../../git-commits.js', () => ({
  computeMergeBase: vi.fn().mockResolvedValue('1111111111111111111111111111111111111111'),
}));

// Silence logger in tests
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  return {
    ...actual,
    childLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    })),
  };
});

const { setupNew } = await import('./new.js');
const { setupExisting } = await import('./existing.js');
const { setupNone } = await import('./none.js');
const { setupScratch } = await import('./scratch.js');
const { runSetup } = await import('./index.js');
const { execFile } = await import('child_process');
const fs = await import('fs');
const { preflightNoneMode } = await import('../../preflight.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(preflightNoneMode).mockResolvedValue({
    ok: true,
    currentBranch: 'main',
    targetBranch: 'main',
    conflicts: [],
    warnings: [],
    dirty: null,
  });
});

afterEach(() => {
  db.close();
});

// ─── setupNew ─────────────────────────────────────────────────────────────────

describe('setupNew', () => {
  const baseTask: Task = {
    ...DEFAULTS.task,
    repo_path: '/tmp/test-repo',
    title: 'Fix order validation',
    id: 'test-task-01',
    run_mode: 'new',
  } as Task;

  it('returns worktreePath inside .worktrees', async () => {
    const result = await setupNew(baseTask);
    expect(result.worktreePath).toContain('.worktrees');
    expect(result.worktreePath.startsWith('/tmp/test-repo')).toBe(true);
  });

  it('returns the branch name', async () => {
    const result = await setupNew(baseTask);
    expect(result.branch).toBeTruthy();
    expect(result.branch).toContain('agents/');
  });

  it('returns a non-null baseSha', async () => {
    const result = await setupNew(baseTask);
    expect(result.baseSha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('sets runPreflight=true', async () => {
    const result = await setupNew(baseTask);
    expect(result.runPreflight).toBe(true);
  });

  it('sets installHooksAt to worktreePath', async () => {
    const result = await setupNew(baseTask);
    expect(result.installHooksAt).toBe(result.worktreePath);
  });

  it('validates the git repo', async () => {
    await setupNew(baseTask);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['rev-parse', '--is-inside-work-tree'],
    });
    expect(call).toBeDefined();
  });

  it('creates a worktree with git worktree add', async () => {
    await setupNew(baseTask);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add'],
    });
    expect(call).toBeDefined();
  });

  it('creates worktree with -b flag for new branch', async () => {
    await setupNew(baseTask);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b'],
    });
    expect(call).toBeDefined();
  });

  it('respects custom branch name from task', async () => {
    const task = { ...baseTask, branch: 'feat/my-custom-branch' };
    const result = await setupNew(task);
    expect(result.branch).toBe('feat/my-custom-branch');
  });

  it('appends baseBranch as start point when provided', async () => {
    const task = { ...baseTask, base_branch: 'develop' };
    await setupNew(task);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', 'develop'],
    });
    expect(call).toBeDefined();
  });

  it('copies settings.local.json when it exists', async () => {
    await setupNew(baseTask);
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled();
  });

  it('skips settings copy when settings file does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      return !String(p).includes('settings.local.json');
    });
    await setupNew(baseTask);
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
  });

  it('throws when repo path does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(setupNew(baseTask)).rejects.toThrow('does not exist');
  });
});

// ─── setupExisting ────────────────────────────────────────────────────────────

describe('setupExisting', () => {
  const baseTask: Task = {
    ...DEFAULTS.task,
    repo_path: '/tmp/test-repo',
    worktree: '/tmp/test-repo/.worktrees/existing',
    run_mode: 'existing',
  } as Task;

  it('throws when worktree is not set', async () => {
    const task = { ...baseTask, worktree: null };
    await expect(setupExisting(task as Task)).rejects.toThrow('requires a worktree path');
  });

  it('throws when worktree does not exist on disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(setupExisting(baseTask)).rejects.toThrow('does not exist');
  });

  it('returns worktreePath = task.worktree', async () => {
    const result = await setupExisting(baseTask);
    expect(result.worktreePath).toBe(baseTask.worktree);
  });

  it('sets runPreflight=false', async () => {
    const result = await setupExisting(baseTask);
    expect(result.runPreflight).toBe(false);
  });

  it('returns a baseSha from rev-parse', async () => {
    const result = await setupExisting(baseTask);
    expect(result.baseSha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('calls git rev-parse --is-inside-work-tree to validate the worktree', async () => {
    await setupExisting(baseTask);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['rev-parse', '--is-inside-work-tree'],
    });
    expect(call).toBeDefined();
  });

  it('resolves branch from rev-parse --abbrev-ref HEAD', async () => {
    const result = await setupExisting(baseTask);
    expect(result.branch).toBe('main');
  });

  it('sets installHooksAt to worktreePath', async () => {
    const result = await setupExisting(baseTask);
    expect(result.installHooksAt).toBe(result.worktreePath);
  });
});

// ─── setupNone ────────────────────────────────────────────────────────────────

describe('setupNone', () => {
  const baseTask: Task = {
    ...DEFAULTS.task,
    repo_path: '/tmp/test-repo',
    run_mode: 'none',
    base_branch: null,
  } as Task;

  it('validates the git repo', async () => {
    await setupNone(baseTask);
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['rev-parse', '--is-inside-work-tree'],
    });
    expect(call).toBeDefined();
  });

  it('returns worktreePath = task.repo_path', async () => {
    const result = await setupNone(baseTask);
    expect(result.worktreePath).toBe(baseTask.repo_path);
  });

  it('sets runPreflight=false', async () => {
    const result = await setupNone(baseTask);
    expect(result.runPreflight).toBe(false);
  });

  it('returns a baseSha from rev-parse', async () => {
    const result = await setupNone(baseTask);
    expect(result.baseSha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('sets installHooksAt to repo_path', async () => {
    const result = await setupNone(baseTask);
    expect(result.installHooksAt).toBe(baseTask.repo_path);
  });

  it('throws when dirty and no target branch', async () => {
    // dirty: has uncommitted changes
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        cb(null, { stdout: ' M dirty-file.ts\n', stderr: '' });
      } else if (args.includes('--abbrev-ref')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (args.includes('--is-inside-work-tree')) {
        cb(null, { stdout: 'true\n', stderr: '' });
      } else {
        cb(null, { stdout: 'abcdef0000000000000000000000000000000000\n', stderr: '' });
      }
      return undefined as any;
    }) as any);

    await expect(setupNone(baseTask)).rejects.toThrow('dirty checkout');
  });

  it('runs preflight when target branch provided', async () => {
    const task = { ...baseTask, base_branch: 'main' };
    await setupNone(task);
    // preflightNoneMode is called with (repoPath, targetBranch, task.id) for defense-in-depth
    expect(preflightNoneMode).toHaveBeenCalledWith('/tmp/test-repo', 'main', task.id);
  });

  it('throws when preflight fails with conflicts', async () => {
    const task = { ...baseTask, base_branch: 'feature', id: 'task-x' };
    vi.mocked(preflightNoneMode).mockResolvedValueOnce({
      ok: false,
      currentBranch: 'main',
      targetBranch: 'feature',
      conflicts: [
        { task_id: 'other-task', title: 'Other', runtime_state: 'running', branch: 'main' },
      ],
      warnings: [],
      dirty: null,
    });

    await expect(setupNone(task)).rejects.toThrow('preflight failed');
  });

  it('does not checkout when already on target branch', async () => {
    // HEAD is already 'main', target is 'main'
    const task = { ...baseTask, base_branch: 'main' };

    vi.mocked(preflightNoneMode).mockResolvedValueOnce({
      ok: true,
      currentBranch: 'main',
      targetBranch: 'main',
      conflicts: [],
      warnings: [],
      dirty: null,
    });

    await setupNone(task);

    const checkoutCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['checkout'],
    });
    expect(checkoutCall).toBeUndefined();
  });
});

// ─── setupScratch ─────────────────────────────────────────────────────────────

describe('setupScratch', () => {
  const baseTask: Task = {
    ...DEFAULTS.task,
    id: 'scratch-task-01',
    run_mode: 'scratch',
  } as Task;

  it('returns a worktreePath under scratch dir', async () => {
    const result = await setupScratch(baseTask);
    expect(result.worktreePath).toContain('scratch-task-01');
  });

  it('creates the scratch directory', async () => {
    await setupScratch(baseTask);
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining('scratch-task-01'),
      { recursive: true },
    );
  });

  it('returns null branch', async () => {
    const result = await setupScratch(baseTask);
    expect(result.branch).toBeNull();
  });

  it('returns null baseBranch', async () => {
    const result = await setupScratch(baseTask);
    expect(result.baseBranch).toBeNull();
  });

  it('returns null baseSha', async () => {
    const result = await setupScratch(baseTask);
    expect(result.baseSha).toBeNull();
  });

  it('sets runPreflight=false', async () => {
    const result = await setupScratch(baseTask);
    expect(result.runPreflight).toBe(false);
  });

  it('sets installHooksAt to the scratch dir', async () => {
    const result = await setupScratch(baseTask);
    expect(result.installHooksAt).toBe(result.worktreePath);
  });
});

// ─── runSetup dispatcher ──────────────────────────────────────────────────────

describe('runSetup', () => {
  it('dispatches to setupNew for run_mode=new', async () => {
    const task: Task = { ...DEFAULTS.task, run_mode: 'new' } as Task;
    insertTask(db, task);
    const result = await runSetup(task);
    // setupNew always sets runPreflight=true
    expect(result.runPreflight).toBe(true);
  });

  it('dispatches to setupExisting for run_mode=existing', async () => {
    const task: Task = {
      ...DEFAULTS.task,
      run_mode: 'existing',
      worktree: '/tmp/existing-worktree',
    } as Task;
    insertTask(db, task);
    const result = await runSetup(task);
    expect(result.runPreflight).toBe(false);
    expect(result.worktreePath).toBe('/tmp/existing-worktree');
  });

  it('dispatches to setupNone for run_mode=none', async () => {
    // Ensure clean working tree so none-mode doesn't throw on dirty check
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        cb(null, { stdout: '', stderr: '' });
      } else if (args.includes('--abbrev-ref')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (args.includes('--is-inside-work-tree')) {
        cb(null, { stdout: 'true\n', stderr: '' });
      } else {
        cb(null, { stdout: 'abcdef0000000000000000000000000000000000\n', stderr: '' });
      }
      return undefined as any;
    }) as any);
    const task: Task = { ...DEFAULTS.task, run_mode: 'none', base_branch: null } as Task;
    insertTask(db, task);
    const result = await runSetup(task);
    expect(result.runPreflight).toBe(false);
    expect(result.worktreePath).toBe(DEFAULTS.task.repo_path);
  });

  it('dispatches to setupScratch for run_mode=scratch', async () => {
    const task: Task = { ...DEFAULTS.task, id: 'scratch-x', run_mode: 'scratch' } as Task;
    insertTask(db, task);
    const result = await runSetup(task);
    expect(result.branch).toBeNull();
    expect(result.baseSha).toBeNull();
  });

  it('throws for unknown run_mode', async () => {
    const task: Task = { ...DEFAULTS.task, run_mode: 'unknown' as any } as Task;
    await expect(runSetup(task)).rejects.toThrow('unknown run_mode');
  });
});
