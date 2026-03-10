import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { initDb, setDb } from './db.js';
import type { Task, Agent } from './types.js';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const DEFAULTS = {
  task: {
    id: 'test-task-01',
    title: 'Fix order validation',
    description: 'Add negative quantity checks',
    repo_path: '/tmp/test-repo',
    status: 'draft' as const,
    branch: null,
    base_branch: null,
    worktree: null,
    tmux_session: null,
    pr_url: null,
    pr_number: null,
    initial_prompt: null,
    error: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  },

  runningTask: {
    id: 'test-task-01',
    title: 'Fix order validation',
    description: 'Add negative quantity checks',
    repo_path: '/tmp/test-repo',
    status: 'running' as const,
    branch: 'agents/test-task-01',
    base_branch: null,
    worktree: '/tmp/test-repo/.worktrees/test-task-01',
    tmux_session: 'octomux-agent-test-task-01',
    pr_url: null,
    pr_number: null,
    initial_prompt: null,
    error: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  },

  agent: {
    id: 'test-agent-01',
    task_id: 'test-task-01',
    window_index: 0,
    label: 'Agent 1',
    status: 'running' as const,
    created_at: '2026-01-01 00:00:00',
  },
} satisfies Record<string, Partial<Task> | Partial<Agent>>;

// Derived constants from defaults
export const SESSION_PREFIX = 'octomux-agent-';
export const BRANCH_PREFIX = 'agents/';
export const WORKTREE_DIR = '.worktrees';

// ─── Database Helpers ────────────────────────────────────────────────────────

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initDb(db);
  setDb(db);
  return db;
}

export function insertTask(db: Database.Database, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    ...DEFAULTS.task,
    agents: undefined,
    ...overrides,
  } as Task;

  db.prepare(
    `INSERT INTO tasks (id, title, description, repo_path, status, branch, base_branch, worktree, tmux_session, pr_url, pr_number, initial_prompt, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.title,
    task.description,
    task.repo_path,
    task.status,
    task.branch,
    task.base_branch,
    task.worktree,
    task.tmux_session,
    task.pr_url,
    task.pr_number,
    task.initial_prompt,
    task.error,
    task.created_at,
    task.updated_at,
  );

  return task;
}

export function insertAgent(db: Database.Database, overrides: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    ...DEFAULTS.agent,
    ...overrides,
  } as Agent;

  db.prepare(
    'INSERT INTO agents (id, task_id, window_index, label, status) VALUES (?, ?, ?, ?, ?)',
  ).run(agent.id, agent.task_id, agent.window_index, agent.label, agent.status);

  return agent;
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function getAgents(db: Database.Database, taskId: string): Agent[] {
  return db.prepare('SELECT * FROM agents WHERE task_id = ?').all(taskId) as Agent[];
}

// ─── Shell Mock Helpers ──────────────────────────────────────────────────────

export interface ShellCallMatch {
  cmd: string;
  argsInclude?: string[];
  argsExclude?: string[];
}

/**
 * Find a matching call in the mocked execFile calls.
 * Returns the full call args or undefined.
 */
export function findExecCall(
  mock: ReturnType<typeof vi.fn>,
  match: ShellCallMatch,
): any[] | undefined {
  return mock.mock.calls.find((c: any[]) => {
    if (c[0] !== match.cmd) return false;
    const args = c[1] as string[];
    if (match.argsInclude && !match.argsInclude.every((a) => args?.includes(a))) return false;
    if (match.argsExclude && match.argsExclude.some((a) => args?.includes(a))) return false;
    return true;
  });
}

/**
 * Count matching calls in the mocked execFile calls.
 */
export function countExecCalls(mock: ReturnType<typeof vi.fn>, match: ShellCallMatch): number {
  return mock.mock.calls.filter((c: any[]) => {
    if (c[0] !== match.cmd) return false;
    const args = c[1] as string[];
    if (match.argsInclude && !match.argsInclude.every((a) => args?.includes(a))) return false;
    return true;
  }).length;
}

// ─── Table-Driven Helpers ────────────────────────────────────────────────────

export const TASKS_TABLE_COLUMNS = [
  'id',
  'title',
  'description',
  'repo_path',
  'status',
  'branch',
  'base_branch',
  'worktree',
  'tmux_session',
  'pr_url',
  'pr_number',
  'initial_prompt',
  'error',
  'created_at',
  'updated_at',
];

export const AGENTS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'window_index',
  'label',
  'status',
  'created_at',
];
