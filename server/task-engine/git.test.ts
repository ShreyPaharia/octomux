import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findExecCall } from '../test-helpers.js';

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
        // Default: branch does not exist
        cb(new Error('fatal: needed a single revision'), null);
      } else if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) {
        cb(null, { stdout: 'true', stderr: '' });
      } else if (args.includes('rev-parse')) {
        cb(null, { stdout: 'abcdef0000000000000000000000000000000000\n', stderr: '' });
      } else if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

const { addWorktreeWithBranch, slugifyTitle, gitBranchExists, revParseHead, checkDirty } =
  await import('./git.js');
const { execFile } = await import('child_process');

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── slugifyTitle ─────────────────────────────────────────────────────────────

describe('slugifyTitle', () => {
  const cases = [
    { title: 'Fix order validation', id: 'test-task-01', expected: 'fix-order-validation-test-t' },
    { title: 'Add NEW feature!!!', id: 'abc123defghi', expected: 'add-new-feature-abc123' },
    { title: '---leading---trailing---', id: 'xyz789', expected: 'leading-trailing-xyz789' },
    { title: 'a'.repeat(60), id: 'id1234', expected: 'a'.repeat(50) + '-id1234' },
    { title: 'Hello   World', id: '123456', expected: 'hello-world-123456' },
    { title: 'Café Résumé', id: 'abc789', expected: 'cafe-resume-abc789' },
    { title: '日本語タイトル only ascii kept', id: 'uni123', expected: 'only-ascii-kept-uni123' },
    { title: 'simple', id: 'abcdef', expected: 'simple-abcdef' },
    { title: 'UPPERCASE TITLE', id: 'upprc1', expected: 'uppercase-title-upprc1' },
  ];

  it.each(cases)('slugifies "$title" → "$expected"', ({ title, id, expected }) => {
    expect(slugifyTitle(title, id)).toBe(expected);
  });

  it('uses only first 6 chars of id as suffix', () => {
    const result = slugifyTitle('test', 'abcdefghijklmnop');
    expect(result).toBe('test-abcdef');
  });
});

// ─── gitBranchExists ─────────────────────────────────────────────────────────

describe('gitBranchExists', () => {
  it('returns false when branch does not exist (execFile errors)', async () => {
    // Default mock: branch probe errors → branch doesn't exist
    const exists = await gitBranchExists('/repo', 'my-branch');
    expect(exists).toBe(false);
  });

  it('calls git rev-parse --verify --quiet refs/heads/<branch>', async () => {
    await gitBranchExists('/repo', 'my-branch');
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['rev-parse', '--verify', '--quiet', 'refs/heads/my-branch'],
    });
    expect(call).toBeDefined();
  });

  it('returns true when branch exists (execFile succeeds)', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_cmd: any, _args: any, optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      cb(null, { stdout: 'abc1234\n', stderr: '' });
      return undefined as any;
    }) as any);
    const exists = await gitBranchExists('/repo', 'existing-branch');
    expect(exists).toBe(true);
  });

  it('passes repo path with -C flag', async () => {
    await gitBranchExists('/my/repo', 'feat/test');
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['-C', '/my/repo'],
    });
    expect(call).toBeDefined();
  });
});

// ─── revParseHead ─────────────────────────────────────────────────────────────

describe('revParseHead', () => {
  it('returns trimmed commit SHA', async () => {
    const sha = await revParseHead('/repo');
    expect(sha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('calls git rev-parse <ref>^{commit} with -C <cwd>', async () => {
    await revParseHead('/my/worktree');
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['-C', '/my/worktree', 'rev-parse', 'HEAD^{commit}'],
    });
    expect(call).toBeDefined();
  });

  it('accepts a custom ref', async () => {
    await revParseHead('/repo', 'main');
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['rev-parse', 'main^{commit}'],
    });
    expect(call).toBeDefined();
  });
});

// ─── checkDirty ──────────────────────────────────────────────────────────────

describe('checkDirty', () => {
  it('returns empty array when working tree is clean', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_cmd: any, _args: any, optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      cb(null, { stdout: '', stderr: '' });
      return undefined as any;
    }) as any);
    const result = await checkDirty('/repo');
    expect(result).toEqual([]);
  });

  it('calls git status --porcelain=v1', async () => {
    await checkDirty('/repo');
    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['status', '--porcelain=v1'],
    });
    expect(call).toBeDefined();
  });

  it('returns dirty files when working tree has changes', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_cmd: any, _args: any, optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      cb(null, { stdout: ' M src/foo.ts\n?? bar.ts\n', stderr: '' });
      return undefined as any;
    }) as any);
    const result = await checkDirty('/repo');
    expect(result).toEqual(['M src/foo.ts', '?? bar.ts']);
  });

  it('filters blank lines from porcelain output', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_cmd: any, _args: any, optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      cb(null, { stdout: ' M a.ts\n\n M b.ts\n', stderr: '' });
      return undefined as any;
    }) as any);
    const result = await checkDirty('/repo');
    expect(result).toHaveLength(2);
  });
});

// ─── addWorktreeWithBranch ────────────────────────────────────────────────────

describe('addWorktreeWithBranch', () => {
  it('creates new branch with -b when branch does not exist (no base)', async () => {
    // Default mock: branch does not exist
    await addWorktreeWithBranch('/repo', '/repo/.worktrees/my-branch', 'agents/my-branch', null);

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b', 'agents/my-branch'],
    });
    expect(call).toBeDefined();
    const args = call![1] as string[];
    // No base branch after the branch name
    const idx = args.indexOf('agents/my-branch');
    expect(args[idx + 1]).toBeUndefined();
  });

  it('creates new branch with -b and base when base is provided', async () => {
    await addWorktreeWithBranch('/repo', '/repo/.worktrees/my-branch', 'agents/my-branch', 'main');

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b', 'agents/my-branch', 'main'],
    });
    expect(call).toBeDefined();
  });

  it('returns the branch name used', async () => {
    const result = await addWorktreeWithBranch(
      '/repo',
      '/repo/.worktrees/my-branch',
      'agents/my-branch',
      null,
    );
    expect(result).toBe('agents/my-branch');
  });

  it('checks out existing branch without -b when branch already exists', async () => {
    // Override so branch-exists probe succeeds
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (
        args.includes('rev-parse') &&
        args.includes('--verify') &&
        args.some((a) => a.startsWith('refs/heads/'))
      ) {
        // Branch EXISTS
        cb(null, { stdout: 'abc1234\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const result = await addWorktreeWithBranch(
      '/repo',
      '/repo/.worktrees/existing',
      'docs/existing',
      null,
    );

    // Checked out bare (no -b)
    const bareCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', 'docs/existing'],
      argsExclude: ['-b'],
    });
    expect(bareCall).toBeDefined();
    expect(result).toBe('docs/existing');
  });

  it('falls back to unique branch with -b suffix when existing branch is already checked out', async () => {
    // Branch EXISTS on rev-parse, but worktree add with bare checkout fails
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (
        args.includes('rev-parse') &&
        args.includes('--verify') &&
        args.some((a) => a.startsWith('refs/heads/'))
      ) {
        // Branch EXISTS
        cb(null, { stdout: 'abc1234\n', stderr: '' });
      } else if (args.includes('worktree') && args.includes('add') && !args.includes('-b')) {
        // Bare worktree add fails (branch checked out elsewhere)
        const err: any = new Error('fatal: branch already checked out elsewhere');
        err.stderr = 'fatal: branch already checked out elsewhere';
        cb(err, null);
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    const result = await addWorktreeWithBranch(
      '/repo',
      '/repo/.worktrees/fallback',
      'agents/my-branch',
      null,
    );

    // Should have fallen back to a unique branch (includes original name + suffix)
    expect(result).toMatch(/^agents\/my-branch-/);
    expect(result.length).toBeGreaterThan('agents/my-branch'.length);

    // Fallback used -b
    const fallbackCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b'],
    });
    expect(fallbackCall).toBeDefined();
  });

  it('collision fallback with base branch appends base to worktree add', async () => {
    // Branch EXISTS, bare checkout fails → fallback should include base
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (
        args.includes('rev-parse') &&
        args.includes('--verify') &&
        args.some((a) => a.startsWith('refs/heads/'))
      ) {
        cb(null, { stdout: 'abc1234\n', stderr: '' });
      } else if (args.includes('worktree') && args.includes('add') && !args.includes('-b')) {
        const err: any = new Error('fatal: branch already checked out elsewhere');
        err.stderr = 'fatal: branch already checked out elsewhere';
        cb(err, null);
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    }) as any);

    await addWorktreeWithBranch(
      '/repo',
      '/repo/.worktrees/fallback',
      'agents/my-branch',
      'develop',
    );

    const fallbackCall = findExecCall(vi.mocked(execFile), {
      cmd: 'git',
      argsInclude: ['worktree', 'add', '-b', 'develop'],
    });
    expect(fallbackCall).toBeDefined();
  });
});
