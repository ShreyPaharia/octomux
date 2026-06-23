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
      dangerouslySkipPermissions: false,
      claudeFlags: '',
    }),
  };
});

vi.mock('./repositories/repo-config.js', () => ({
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
} = await import('./task-engine/index.js');
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
        pr_head_sha  TEXT,
        user_window_index INTEGER,
        initial_prompt TEXT,
        last_viewed_at TEXT,
        source       TEXT,
        run_mode     TEXT,
        base_sha     TEXT,
        error        TEXT,
        no_worktree INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        window_index INTEGER NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        claude_session_id TEXT,
        hook_activity TEXT NOT NULL DEFAULT 'active',
        hook_activity_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE permission_prompts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        agent_id TEXT, session_id TEXT, tool_name TEXT,
        tool_input TEXT, status TEXT, created_at TEXT, resolved_at TEXT
      );
      CREATE TABLE user_terminals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        window_index INTEGER, label TEXT, status TEXT, created_at TEXT
      );
      CREATE TABLE repo_configs (repo_path TEXT PRIMARY KEY);
      CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1));
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
          `INSERT INTO tasks (id, title, description, repo_path, no_worktree, worktree)
           VALUES (?, 'T', 'D', ?, ?, ?)`,
        )
        .run(
          id,
          repo_path,
          no_worktree,
          // Phase 2a migrates tasks with a worktree path into the worktrees
          // table. Give each case a plausible path so the backfill fires.
          expected === 'scratch' ? `/scratch/${id}` : `/tmp/.worktrees/${id}`,
        );

      initDb(legacy);

      // After migration the Task.run_mode lives on worktrees.mode (joined).
      const row = legacy
        .prepare(
          `SELECT w.mode AS mode FROM tasks t
             LEFT JOIN worktrees w ON t.worktree_id = w.id
            WHERE t.id = ?`,
        )
        .get(id) as { mode: string };
      expect(row.mode).toBe(expected);

      const cols = (legacy.pragma('table_info(tasks)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).not.toContain('no_worktree');
      // Legacy columns are dropped after Phase 2a.
      expect(cols).not.toContain('run_mode');
      expect(cols).not.toContain('worktree');
      legacy.close();
    },
  );
});

// ─── Partial unique indexes (race test) ─────────────────────────────────────

describe('partial unique indexes', () => {
  it('rejects two concurrent tasks sharing the same worktree_id', () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status)
       VALUES ('shared-wt', '/some/user/repo', 'existing', 'in_use')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('t1', 'T', 'D', 'running', 'shared-wt')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
           VALUES ('t2', 'T', 'D', 'setting_up', 'shared-wt')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('allows a closed task to share a worktree_id with a new active one', () => {
    db.prepare(
      `INSERT INTO worktrees (id, path, mode, status)
       VALUES ('shared-wt-2', '/some/user/repo', 'existing', 'available')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
       VALUES ('t-closed', 'T', 'D', 'idle', 'shared-wt-2')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
           VALUES ('t-running', 'T', 'D', 'running', 'shared-wt-2')`,
        )
        .run(),
    ).not.toThrow();
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
    expect(updated.runtime_state).toBe('error');
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
    insertTask(db, {
      id: 'ghost',
      runtime_state: 'setting_up',
      tmux_session: 'octomux-agent-ghost',
    });
    await reconcileOrphanSettingUp();
    const t = getTask(db, 'ghost')!;
    expect(t.runtime_state).toBe('error');
    expect(t.error).toContain('orphan setting_up');
  });

  it('leaves setting_up tasks with live tmux session alone', async () => {
    execState.hasSession = () => true;
    insertTask(db, {
      id: 'alive',
      runtime_state: 'setting_up',
      tmux_session: 'octomux-agent-alive',
    });
    await reconcileOrphanSettingUp();
    const t = getTask(db, 'alive')!;
    expect(t.runtime_state).toBe('setting_up');
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
      runtime_state: 'running',
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
