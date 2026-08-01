import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, findCallback } from '../test-helpers.js';
import { listPullRequestsByTask } from '../repositories/pull-requests.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../events.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
}));

const { execFile } = await import('child_process');
const { broadcast } = await import('../events.js');
const { fireHook } = await import('../hook-dispatcher.js');
const { pollPRs } = await import('./pr-detection.js');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Build the mock execFile implementation for a PR-detection scenario. */
function mockExecFile(options: {
  /** git remote get-url returns this (determines owner/repo). */
  remoteUrl?: string;
  /** Branches returned by `git branch --list '...*'`. */
  sliceBranches?: string[];
  /** GraphQL response data keyed by alias `pr0`, `pr1`, etc. */
  graphqlData?: Record<
    string,
    { pullRequests: { nodes: Array<{ number: number; url: string; state: string }> } } | null
  >;
}) {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], ...rest: any[]) => {
    const cb = findCallback(...rest);
    if (!cb) return undefined as any;

    if (cmd === 'git' && args?.includes('remote') && args?.includes('get-url')) {
      cb(null, { stdout: `${options.remoteUrl ?? 'git@github.com:org/repo.git'}\n`, stderr: '' });
    } else if (cmd === 'git' && args?.includes('branch') && args?.includes('--list')) {
      const out = (options.sliceBranches ?? []).map((b) => `  ${b}`).join('\n');
      cb(null, { stdout: out ? `${out}\n` : '', stderr: '' });
    } else if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'graphql') {
      cb(null, {
        stdout: JSON.stringify({ data: options.graphqlData ?? {} }),
        stderr: '',
      });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
    return undefined as any;
  }) as unknown as typeof execFile);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('pollPRs (pr-detection)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it('upserts two pull_request rows when a task has a main + slice branch with PRs', async () => {
    const taskId = 'task-pd-1';
    const mainBranch = 'agents/task-pd-1';
    const sliceBranch = 'agents/task-pd-1-slice1';

    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      branch: mainBranch,
      repo_path: '/repo',
    });

    mockExecFile({
      sliceBranches: [sliceBranch],
      graphqlData: {
        pr0: {
          pullRequests: { nodes: [{ number: 10, url: 'https://gh/pull/10', state: 'OPEN' }] },
        },
        pr1: {
          pullRequests: { nodes: [{ number: 11, url: 'https://gh/pull/11', state: 'OPEN' }] },
        },
      },
    });

    await pollPRs();

    const prs = listPullRequestsByTask(taskId);
    expect(prs).toHaveLength(2);
    const numbers = prs.map((p) => p.number).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(numbers).toEqual([10, 11]);
  });

  it('maps GitHub MERGED state to merged', async () => {
    const taskId = 'task-pd-2';
    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      branch: 'agents/task-pd-2',
      repo_path: '/repo',
    });

    mockExecFile({
      graphqlData: {
        pr0: { pullRequests: { nodes: [{ number: 5, url: 'u5', state: 'MERGED' }] } },
      },
    });

    await pollPRs();

    const prs = listPullRequestsByTask(taskId);
    expect(prs).toHaveLength(1);
    expect(prs[0].state).toBe('merged');
  });

  it('maps GitHub CLOSED state to closed', async () => {
    const taskId = 'task-pd-3';
    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      branch: 'agents/task-pd-3',
      repo_path: '/repo',
    });

    mockExecFile({
      graphqlData: {
        pr0: { pullRequests: { nodes: [{ number: 6, url: 'u6', state: 'CLOSED' }] } },
      },
    });

    await pollPRs();

    const prs = listPullRequestsByTask(taskId);
    expect(prs[0].state).toBe('closed');
  });

  it('sets derived primary on tasks.pr_url after first PR', async () => {
    const taskId = 'task-pd-4';
    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      branch: 'agents/task-pd-4',
      repo_path: '/repo',
    });

    mockExecFile({
      graphqlData: {
        pr0: {
          pullRequests: { nodes: [{ number: 42, url: 'https://gh/pull/42', state: 'OPEN' }] },
        },
      },
    });

    await pollPRs();

    const row = db.prepare(`SELECT pr_url, pr_number FROM tasks WHERE id = ?`).get(taskId) as {
      pr_url: string | null;
      pr_number: number | null;
    };

    expect(row.pr_url).toBe('https://gh/pull/42');
    expect(row.pr_number).toBe(42);
  });

  it('fires workflow transition + broadcast on first PR detection when in_progress', async () => {
    const taskId = 'task-pd-5';
    insertTask(db, {
      id: taskId,
      runtime_state: 'running',
      workflow_status: 'in_progress',
      branch: 'agents/task-pd-5',
      repo_path: '/repo',
    });
    // Add an agent so insertAgent can exist; not required by pollPRs itself.
    insertAgent(db, {
      id: 'agent-pd-5',
      task_id: taskId,
      hook_token: 'tok',
      status: 'running',
    } as any);

    mockExecFile({
      graphqlData: {
        pr0: {
          pullRequests: { nodes: [{ number: 99, url: 'https://gh/pull/99', state: 'OPEN' }] },
        },
      },
    });

    await pollPRs();

    expect(broadcast).toHaveBeenCalledWith({ type: 'task:updated', payload: { taskId } });
    expect(fireHook).toHaveBeenCalledWith(
      'workflow_status_changed',
      expect.objectContaining({
        data: expect.objectContaining({ to: 'pr' }),
      }),
    );
  });

  it('does NOT fire workflow transition when task has no prior PR but workflow_status is not in_progress/human_review', async () => {
    const taskId = 'task-pd-6';
    insertTask(db, {
      id: taskId,
      runtime_state: 'idle',
      workflow_status: 'backlog',
      branch: 'agents/task-pd-6',
      repo_path: '/repo',
    });

    mockExecFile({
      graphqlData: {
        pr0: { pullRequests: { nodes: [{ number: 77, url: 'u77', state: 'OPEN' }] } },
      },
    });

    await pollPRs();

    expect(fireHook).not.toHaveBeenCalled();
    // broadcast IS called (the task got a new PR)
    expect(broadcast).toHaveBeenCalledWith({ type: 'task:updated', payload: { taskId } });
  });
});
