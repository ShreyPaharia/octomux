import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { initDb } from './db.js';
import {
  createTestDb,
  insertTask,
  getTask,
  findExecCall,
  countExecCalls,
  DEFAULTS,
} from './test-helpers.js';
import type { Task } from './types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => [] as any),
  };
  return { ...mocked, default: mocked };
});

vi.mock('./hook-settings.js', () => ({
  installHookSettings: vi.fn(),
}));

vi.mock('./settings.js', async () => {
  const actual = await vi.importActual<typeof import('./settings.js')>('./settings.js');
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      useOrchestratorAgent: false,
      dangerouslySkipPermissions: false,
      claudeFlags: '',
    }),
  };
});

vi.mock('./repo-config.js', () => ({
  getOrCreateRepoConfig: vi.fn().mockResolvedValue({
    repo_path: '/repo',
    base_branch: null,
    test_command: 'bun run test',
    format_command: 'bun run format',
    lint_command: 'bun run lint',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }),
}));

let nextWindowIndex = 0;

interface ExecMocks {
  dirty?: boolean;
  hasSession?: (sess: string) => boolean;
}
const execState: ExecMocks = {};

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('display-message')) {
        return cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      }
      if (args.includes('list-windows')) {
        return cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      }
      if (args.includes('new-window')) {
        nextWindowIndex++;
        return cb(null, { stdout: '', stderr: '' });
      }
      if (args.includes('has-session')) {
        const sess = args[args.indexOf('-t') + 1] || '';
        const ok = execState.hasSession ? execState.hasSession(sess) : true;
        if (!ok) return cb(new Error(`no session ${sess}`));
        return cb(null, { stdout: '', stderr: '' });
      }
      if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        return cb(null, {
          stdout: execState.dirty ? ' M foo.ts\n?? bar.ts\n' : '',
          stderr: '',
        });
      }
      if (args.includes('rev-parse')) {
        return cb(null, { stdout: 'abcdef0000000000000000000000000000000000\n', stderr: '' });
      }
      if (cmd === 'tmux' && args.includes('list-sessions')) {
        return cb(null, { stdout: '', stderr: '' });
      }
      return cb(null, { stdout: 'true', stderr: '' });
    },
  ),
}));

const {
  startTask,
  deleteTask,
  reconcileOrphanSettingUp,
  gcScratchDirs,
  scratchDirFor,
  scratchRoot,
} = await import('./task-runner.js');
const { execFile } = await import('child_process');
const fsMod = await import('fs');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(fsMod.existsSync).mockReturnValue(true);
  nextWindowIndex = 0;
  execState.dirty = false;
  execState.hasSession = undefined;
});

afterEach(() => {
  db.close();
});

// ─── Migration test ──────────────────────────────────────────────────────────

describe('migration: no_worktree → run_mode', () => {
  // Build a legacy-shaped DB manually by creating the schema with no_worktree
  // column, inserting mixed-shape rows, then running initDb on it.
  function legacyDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE tasks (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL,
        repo_path    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'draft',
        branch       TEXT,
        base_branch  TEXT,
        worktree     TEXT,
        tmux_session TEXT,
        pr_url       TEXT,
        pr_number    INTEGER,
        initial_prompt TEXT,
        error        TEXT,
        no_worktree INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    return db;
  }

  const cases = [
    { id: 't-new', no_worktree: 0, repo_path: '/tmp/r', expected: 'new' },
    { id: 't-none', no_worktree: 1, repo_path: '/tmp/r', expected: 'none' },
    { id: 't-scratch', no_worktree: 1, repo_path: '', expected: 'scratch' },
  ];

  it.each(cases)(
    'backfills $id with no_worktree=$no_worktree,repo=$repo_path → $expected',
    ({ id, no_worktree, repo_path, expected }) => {
      const legacy = legacyDb();
      legacy
        .prepare(
          `INSERT INTO tasks (id, title, description, repo_path, no_worktree)
           VALUES (?, 'T', 'D', ?, ?)`,
        )
        .run(id, repo_path, no_worktree);

      initDb(legacy);

      const row = legacy.prepare('SELECT run_mode FROM tasks WHERE id = ?').get(id) as {
        run_mode: string;
      };
      expect(row.run_mode).toBe(expected);

      const cols = (legacy.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).not.toContain('no_worktree');
      legacy.close();
    },
  );
});

// ─── Partial unique indexes (race test) ─────────────────────────────────────

describe('partial unique indexes', () => {
  it('rejects two concurrent existing-mode tasks with same worktree', () => {
    insertTask(db, {
      id: 't1',
      run_mode: 'existing',
      status: 'running',
      worktree: '/some/user/repo',
    });
    expect(() =>
      insertTask(db, {
        id: 't2',
        run_mode: 'existing',
        status: 'setting_up',
        worktree: '/some/user/repo',
      }),
    ).toThrow(/UNIQUE/i);
  });

  it('allows closed existing-mode task to share worktree with a new one', () => {
    insertTask(db, {
      id: 't-closed',
      run_mode: 'existing',
      status: 'closed',
      worktree: '/some/user/repo',
    });
    expect(() =>
      insertTask(db, {
        id: 't-running',
        run_mode: 'existing',
        status: 'running',
        worktree: '/some/user/repo',
      }),
    ).not.toThrow();
  });

  it('rejects two concurrent none-mode tasks with same repo_path', () => {
    insertTask(db, { id: 't1', run_mode: 'none', status: 'running', repo_path: '/shared/repo' });
    expect(() =>
      insertTask(db, {
        id: 't2',
        run_mode: 'none',
        status: 'setting_up',
        repo_path: '/shared/repo',
      }),
    ).toThrow(/UNIQUE/i);
  });
});

// ─── Per-mode setup: git worktree add only in new mode ──────────────────────

describe('startTask per-mode setup', () => {
  const modes = [
    { mode: 'new' as const, callsWorktreeAdd: 1 },
    { mode: 'none' as const, callsWorktreeAdd: 0 },
    { mode: 'scratch' as const, callsWorktreeAdd: 0 },
  ];

  it.each(modes)(
    '$mode mode calls worktree add $callsWorktreeAdd times',
    async ({ mode, callsWorktreeAdd }) => {
      const task: Task = { ...DEFAULTS.task, run_mode: mode } as Task;
      if (mode === 'scratch') task.repo_path = '';
      insertTask(db, { ...task });
      await startTask(task);

      expect(
        countExecCalls(vi.mocked(execFile), { cmd: 'git', argsInclude: ['worktree', 'add'] }),
      ).toBe(callsWorktreeAdd);
    },
  );

  it('existing mode does not call worktree add and captures base_sha from HEAD', async () => {
    const task: Task = {
      ...DEFAULTS.task,
      run_mode: 'existing',
      worktree: '/user/existing/wt',
    } as Task;
    insertTask(db, { ...task });
    await startTask(task);

    expect(
      countExecCalls(vi.mocked(execFile), { cmd: 'git', argsInclude: ['worktree', 'add'] }),
    ).toBe(0);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.base_sha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('captures base_sha for new mode', async () => {
    const task: Task = { ...DEFAULTS.task, run_mode: 'new', base_branch: 'main' } as Task;
    insertTask(db, { ...task });
    await startTask(task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.base_sha).toBe('abcdef0000000000000000000000000000000000');
  });

  it('scratch mode stores worktree inside ~/.octomux/scratch/<id>', async () => {
    const task: Task = { ...DEFAULTS.task, run_mode: 'scratch', repo_path: '' } as Task;
    insertTask(db, { ...task });
    await startTask(task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.worktree).toBe(scratchDirFor(DEFAULTS.task.id));
    expect(updated.base_sha).toBeNull();
  });
});

// ─── none mode dirty refuse ─────────────────────────────────────────────────

describe('none mode dirty checkout refusal', () => {
  it('fails setup and sets status=error when checkout is dirty', async () => {
    execState.dirty = true;
    const task: Task = { ...DEFAULTS.task, run_mode: 'none' } as Task;
    insertTask(db, { ...task });
    await startTask(task);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.status).toBe('error');
    expect(updated.error).toMatch(/dirty/i);
    expect(updated.error).toContain('foo.ts');
  });
});

// ─── deleteTask safety for existing mode ────────────────────────────────────

describe('deleteTask safety', () => {
  it('never calls git worktree remove for run_mode=existing', async () => {
    const task: Task = {
      ...DEFAULTS.runningTask,
      run_mode: 'existing',
      worktree: '/Users/private/special-repo',
      branch: 'user/wip',
    } as Task;
    insertTask(db, { ...task });
    await deleteTask(task);

    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['worktree', 'remove'] }),
    ).toBeUndefined();
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['branch', '-D'] }),
    ).toBeUndefined();
  });

  it('rm -rf scratch dir for run_mode=scratch', async () => {
    const scratchDir = path.join(scratchRoot(), DEFAULTS.runningTask.id);
    const task: Task = {
      ...DEFAULTS.runningTask,
      run_mode: 'scratch',
      worktree: scratchDir,
      repo_path: '',
    } as Task;
    insertTask(db, { ...task });
    await deleteTask(task);

    expect(vi.mocked(fsMod.rmSync)).toHaveBeenCalledWith(scratchDir, expect.any(Object));
  });
});

// ─── Boot reconciliation: orphan setting_up sweep ───────────────────────────

describe('reconcileOrphanSettingUp', () => {
  it('transitions setting_up tasks with dead tmux session to error', async () => {
    execState.hasSession = () => false;
    insertTask(db, { id: 'ghost', status: 'setting_up', tmux_session: 'octomux-agent-ghost' });
    await reconcileOrphanSettingUp();
    const t = getTask(db, 'ghost')!;
    expect(t.status).toBe('error');
    expect(t.error).toContain('orphan setting_up');
  });

  it('leaves setting_up tasks with live tmux session alone', async () => {
    execState.hasSession = () => true;
    insertTask(db, { id: 'alive', status: 'setting_up', tmux_session: 'octomux-agent-alive' });
    await reconcileOrphanSettingUp();
    const t = getTask(db, 'alive')!;
    expect(t.status).toBe('setting_up');
  });
});

// ─── Boot reconciliation: scratch GC ────────────────────────────────────────

describe('gcScratchDirs', () => {
  beforeEach(() => {
    vi.mocked(fsMod.existsSync).mockReset();
    vi.mocked(fsMod.readdirSync).mockReset();
    vi.mocked(fsMod.rmSync).mockReset();
  });

  it('removes scratch dirs with no matching active task', async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue([
      { name: 'orphan-id', isDirectory: () => true } as any,
    ]);

    await gcScratchDirs();

    expect(vi.mocked(fsMod.rmSync)).toHaveBeenCalledWith(
      path.join(os.homedir(), '.octomux', 'scratch', 'orphan-id'),
      expect.any(Object),
    );
  });

  it('preserves scratch dirs for active scratch tasks', async () => {
    insertTask(db, {
      id: 'alive-scratch',
      run_mode: 'scratch',
      status: 'running',
      repo_path: '',
      worktree: path.join(os.homedir(), '.octomux', 'scratch', 'alive-scratch'),
    });
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue([
      { name: 'alive-scratch', isDirectory: () => true } as any,
      { name: 'stale-id', isDirectory: () => true } as any,
    ]);

    await gcScratchDirs();

    // Did not remove the alive one; did remove the stale one
    const calls = vi.mocked(fsMod.rmSync).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain(path.join(os.homedir(), '.octomux', 'scratch', 'alive-scratch'));
    expect(calls).toContain(path.join(os.homedir(), '.octomux', 'scratch', 'stale-id'));
  });
});

// ─── Diff module base_sha E2E (integration-style with real git) ─────────────

// The server/api.test.ts already covers the 400-on-missing-base_sha and
// scratch-400 cases via mocked diffMod. For completeness we verify that the
// diff module itself works against a real captured SHA — that's covered by
// diff.test.ts's existing tests (they already pass an arbitrary ref as base).
