import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from '../sqlite.js';
import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';
import type { ComputeFiles, ComputeSession, ExecResult } from '../compute/types.js';
import type { Task } from '../types.js';

// ─── Fake compute session ──────────────────────────────────────────────────
//
// `sessionFor`/`releaseSession` are mocked so `tmux` is a pure in-memory
// fake (no real tmux binary needed) while `exec`/`files` proxy straight
// through to the REAL local implementations (real child_process `git`, real
// fs) — worktree/branch teardown tests below run against a genuine temp git
// repo, not a simulation of one. Per-test hooks let a handful of cases force
// a specific git/filesystem outcome (a stuck worktree, a branch that
// survives its own delete) without faking the whole engine.

let tmuxCalls: string[][] = [];
let tmuxHandler: (args: string[]) => { stdout: string; stderr: string } = () => ({
  stdout: '',
  stderr: '',
});

type ExecOverrideResult = 'passthrough' | ExecResult | Error;
let execOverride: ((argv: string[]) => ExecOverrideResult) | null = null;

let filesExistsOverride: ((p: string) => Promise<boolean>) | null = null;
let filesRmOverride: ((p: string, opts?: { recursive?: boolean }) => Promise<void>) | null = null;

const disposeCalls: Array<{ destroy?: boolean } | undefined> = [];

function resetFakeComputeState(): void {
  tmuxCalls = [];
  tmuxHandler = () => ({ stdout: '', stderr: '' });
  execOverride = null;
  filesExistsOverride = null;
  filesRmOverride = null;
  disposeCalls.length = 0;
}

function makeFakeSession(
  task: { id: string; repo_path: string },
  real: { localExec: typeof import('../compute/local.js').localExec; localFiles: ComputeFiles },
): ComputeSession {
  return {
    kind: 'local',
    taskId: task.id,
    repoPath: task.repo_path,
    async exec(argv, opts) {
      if (execOverride) {
        const r = execOverride(argv);
        if (r === 'passthrough') return real.localExec(argv, opts);
        if (r instanceof Error) throw r;
        return r;
      }
      return real.localExec(argv, opts);
    },
    async tmux(args) {
      tmuxCalls.push(args);
      return tmuxHandler(args);
    },
    async spawn() {
      throw new Error('spawn not exercised by cleanup tests');
    },
    files: {
      ...real.localFiles,
      exists: (p: string) => (filesExistsOverride ?? real.localFiles.exists)(p),
      rm: (p: string, opts?: { recursive?: boolean }) =>
        (filesRmOverride ?? real.localFiles.rm)(p, opts),
    },
    async dispose(opts) {
      disposeCalls.push(opts);
    },
  };
}

vi.mock('../compute/index.js', (importOriginal) => {
  const actual = importOriginal<typeof import('../compute/index.js')>();
  const sessionFor = vi.fn(async (task: Task) =>
    makeFakeSession(task, { localExec: actual.localExec, localFiles: actual.localFiles }),
  );
  const releaseSession = vi.fn(async () => {});
  return { ...actual, sessionFor, releaseSession };
});

const { createTestDb, insertTask } = await import('../test-helpers.js');
const { getTaskRuntimeState } = await import('../repositories/index.js');
const { closeTask, deleteTask } = await import('./cleanup.js');
const { sessionFor, releaseSession } = await import('../compute/index.js');

// ─── Temp git repo helper ───────────────────────────────────────────────────

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' });
}

let repoCounter = 0;

/** Real `git init` + a real worktree cut off it — no mocking below this. */
function makeTempRepoWithWorktree(): { repoPath: string; worktreePath: string; branch: string } {
  repoCounter += 1;
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `octomux-cleanup-test-${repoCounter}-`));
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  const branch = `agents/cleanup-test-${repoCounter}`;
  const worktreePath = path.join(repoPath, '.worktrees', `cleanup-test-${repoCounter}`);
  git(repoPath, ['worktree', 'add', '-q', '-b', branch, worktreePath]);
  return { repoPath, worktreePath, branch };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let db: Database;

beforeEach(() => {
  db = createTestDb();
  resetFakeComputeState();
  vi.mocked(sessionFor).mockClear();
  vi.mocked(releaseSession).mockClear();
});

// ─── closeTask ──────────────────────────────────────────────────────────────

describe('closeTask', () => {
  it('kills the tmux session and marks the task idle', async () => {
    const task = insertTask(db, {
      id: 't-close-1',
      runtime_state: 'running',
      tmux_session: 'octomux-agent-t-close-1',
    });

    const report = await closeTask(task);

    expect(report).toEqual({ alreadyIdle: false, tmuxKilled: true });
    expect(tmuxCalls).toContainEqual(['kill-session', '-t', 'octomux-agent-t-close-1']);
    expect(getTaskRuntimeState('t-close-1')?.runtime_state).toBe('idle');
  });

  it('reports alreadyIdle when runtime_state was already idle at entry', async () => {
    const task = insertTask(db, {
      id: 't-close-2',
      runtime_state: 'idle',
      tmux_session: null,
    });

    const report = await closeTask(task);

    expect(report).toEqual({ alreadyIdle: true, tmuxKilled: false });
    expect(getTaskRuntimeState('t-close-2')?.runtime_state).toBe('idle');
  });

  it('does not throw and reports tmuxKilled false when the tmux session is already gone', async () => {
    const task = insertTask(db, {
      id: 't-close-3',
      runtime_state: 'running',
      tmux_session: 'octomux-agent-t-close-3',
    });
    tmuxHandler = (args) => {
      if (args.includes('kill-session')) {
        const err = new Error("can't find session") as Error & { stderr?: string };
        err.stderr = "can't find session: octomux-agent-t-close-3";
        throw err;
      }
      return { stdout: '', stderr: '' };
    };

    const report = await closeTask(task);

    expect(report).toEqual({ alreadyIdle: false, tmuxKilled: false });
    expect(getTaskRuntimeState('t-close-3')?.runtime_state).toBe('idle');
  });
});

// ─── deleteTask ─────────────────────────────────────────────────────────────
//
// Case 4 (the happy path) runs the real thing end-to-end: a real temp git
// repo, a real `git worktree add`, and asserts on the real filesystem/git
// state afterward, per the ticket's "strongest test you can write" ask.
// The rest reuse the same real repo but pin one exec/files behavior to force
// the failure path, since reproducing a genuinely stuck worktree/branch
// through real git behavior alone is either version-dependent (locked
// worktrees) or outright racy to set up.

describe('deleteTask', () => {
  let repoPath: string | undefined;

  afterEach(() => {
    if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
    repoPath = undefined;
  });

  it('removes the worktree and branch for real against a temp git repo', async () => {
    const repo = makeTempRepoWithWorktree();
    repoPath = repo.repoPath;
    const task = insertTask(db, {
      id: 't-del-1',
      run_mode: 'new',
      repo_path: repo.repoPath,
      worktree: repo.worktreePath,
      branch: repo.branch,
      tmux_session: null,
    });

    const report = await deleteTask(task);

    expect(report).toEqual({ worktreeRemoved: true, branchDeleted: true, errors: [] });
    expect(fs.existsSync(repo.worktreePath)).toBe(false);
    expect(git(repo.repoPath, ['branch', '--list', repo.branch]).trim()).toBe('');
  });

  it('prunes a dangling worktree registration when remove fails but the dir is already gone', async () => {
    const repo = makeTempRepoWithWorktree();
    repoPath = repo.repoPath;
    // Simulate the real-world case: the dir was deleted out from under git.
    fs.rmSync(repo.worktreePath, { recursive: true, force: true });
    execOverride = (argv) =>
      argv.includes('worktree') && argv.includes('remove')
        ? new Error('synthetic: worktree remove failed')
        : 'passthrough';

    const task = insertTask(db, {
      id: 't-del-2',
      run_mode: 'new',
      repo_path: repo.repoPath,
      worktree: repo.worktreePath,
      branch: repo.branch,
      tmux_session: null,
    });

    const report = await deleteTask(task);

    expect(report.worktreeRemoved).toBe(true);
    expect(report.errors).toEqual([]);
    expect(git(repo.repoPath, ['worktree', 'list'])).not.toContain(repo.worktreePath);
  });

  it('reports worktreeRemoved false with errors, and does not throw, when the worktree survives every attempt', async () => {
    const repo = makeTempRepoWithWorktree();
    repoPath = repo.repoPath;
    // Models a real filesystem that simply refuses to lose the directory —
    // `exists` never flips to false no matter what deleteTask tries.
    filesExistsOverride = async () => true;
    filesRmOverride = async () => {};

    const task = insertTask(db, {
      id: 't-del-3',
      run_mode: 'new',
      repo_path: repo.repoPath,
      worktree: repo.worktreePath,
      branch: repo.branch,
      tmux_session: null,
    });

    const report = await deleteTask(task);

    expect(report.worktreeRemoved).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('reports branchDeleted false when rev-parse --verify still resolves the branch', async () => {
    const repo = makeTempRepoWithWorktree();
    repoPath = repo.repoPath;
    // `git branch -D` "succeeds" without actually touching the branch, so
    // the verify step is the only thing standing between us and a false
    // positive.
    execOverride = (argv) =>
      argv.includes('branch') && argv.includes('-D')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : 'passthrough';

    const task = insertTask(db, {
      id: 't-del-4',
      run_mode: 'new',
      repo_path: repo.repoPath,
      worktree: repo.worktreePath,
      branch: repo.branch,
      tmux_session: null,
    });

    const report = await deleteTask(task);

    expect(report.branchDeleted).toBe(false);
    expect(report.errors.some((e) => e.includes(repo.branch))).toBe(true);
  });
});
