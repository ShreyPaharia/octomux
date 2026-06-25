/**
 * Repro: opening a 2nd task on the same shared main branch (run_mode=none) while
 * a 1st task is still running.
 *
 * Tracks PR fix/multi-task-shared-main-session-start.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, getTask, DEFAULTS } from './test-helpers.js';
import type { Task } from './types.js';

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

vi.mock('./harnesses/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('./harnesses/index.js')>('./harnesses/index.js');
  const claudeCode = {
    ...actual.getHarness('claude-code'),
    installHooks: vi.fn().mockResolvedValue(undefined),
    syncAgents: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...actual,
    getHarness: (id?: string | null) => {
      const h = actual.getHarness(id);
      return h.id === 'claude-code' ? claudeCode : h;
    },
  };
});

vi.mock('./settings.js', async () => {
  const actual = await vi.importActual<typeof import('./settings.js')>('./settings.js');
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      defaultHarnessId: 'claude-code',
      harnesses: {},
    }),
  };
});

let nextWindowIndex = 0;
const tmuxSessions = new Set<string>();

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (cmd === 'tmux' && args.includes('new-session')) {
        const sessIdx = args.indexOf('-s') + 1;
        const sess = args[sessIdx] || '';
        if (tmuxSessions.has(sess)) {
          return cb(
            Object.assign(new Error(`tmux: duplicate session name`), {
              stderr: `duplicate session: ${sess}`,
            }),
          );
        }
        tmuxSessions.add(sess);
        return cb(null, { stdout: '', stderr: '' });
      }
      if (args.includes('display-message') || args.includes('list-windows')) {
        return cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      }
      if (args.includes('new-window')) {
        nextWindowIndex++;
        return cb(null, { stdout: '', stderr: '' });
      }
      if (args.includes('has-session')) {
        const sess = args[args.indexOf('-t') + 1] || '';
        if (!tmuxSessions.has(sess)) return cb(new Error(`no session ${sess}`));
        return cb(null, { stdout: '', stderr: '' });
      }
      if (args.includes('--abbrev-ref') && args.includes('HEAD')) {
        return cb(null, { stdout: 'main\n', stderr: '' });
      }
      if (args.includes('status') && args.some((a) => String(a).startsWith('--porcelain'))) {
        return cb(null, { stdout: '', stderr: '' });
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

const { startTask } = await import('./task-engine/index.js');

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  nextWindowIndex = 0;
  tmuxSessions.clear();
});

afterEach(() => {
  db.close();
});

function noneTask(id: string): Task {
  // Mirror the production API insert path: create a worktree row with
  // mode='none', repo_path set, branch=null, base_branch='main'.
  const wtId = `wt-${id}`;
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES (?, ?, ?, NULL, 'main', 'none', 'available')`,
  ).run(wtId, '/repo', '/repo');
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, worktree_id)
     VALUES (?, 'T', 'D', 'setting_up', ?)`,
  ).run(id, wtId);

  return {
    ...DEFAULTS.task,
    id,
    run_mode: 'none' as const,
    repo_path: '/repo',
    base_branch: 'main',
    runtime_state: 'setting_up' as const,
    worktree_id: wtId,
  } as unknown as Task;
}

describe('two none-mode tasks on the same repo + base_branch', () => {
  it('first task reaches running on its own', async () => {
    const a = noneTask('task-a');

    await startTask(a);

    const updated = getTask(db, 'task-a')!;
    expect(updated.runtime_state).toBe('running');
    expect(updated.tmux_session).toBe('octomux-agent-task-a');
    expect(updated.error).toBeNull();
  });

  it('second task on the same repo+branch also reaches running', async () => {
    const a = noneTask('task-a');
    await startTask(a);
    const aFinal = getTask(db, 'task-a')!;
    expect(aFinal.runtime_state).toBe('running');

    const b = noneTask('task-b');
    await startTask(b);

    const bFinal = getTask(db, 'task-b')!;
    expect(bFinal.runtime_state).toBe('running');
    expect(bFinal.tmux_session).toBe('octomux-agent-task-b');
    expect(bFinal.error).toBeNull();
    expect(aFinal.tmux_session).not.toBe(bFinal.tmux_session);
  });
});
