import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { initDb, setDb } from './db.js';
import type { Task, Agent, UserTerminal } from './types.js';

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
    user_window_index: null,
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
    branch: 'agents/fix-order-validation-test-t',
    base_branch: null,
    worktree: '/tmp/test-repo/.worktrees/fix-order-validation-test-t',
    tmux_session: 'octomux-agent-test-task-01',
    pr_url: null,
    pr_number: null,
    user_window_index: null,
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
    claude_session_id: 'test-session-uuid-01',
    created_at: '2026-01-01 00:00:00',
  },

  userTerminal: {
    id: 'test-terminal-01',
    task_id: 'test-task-01',
    window_index: 2,
    label: 'Terminal 1',
    status: 'idle' as const,
    created_at: '2026-01-01 00:00:00',
  },

  permissionPrompt: {
    id: 'pp_test123456',
    task_id: 'task_test1234',
    agent_id: 'agent_test123',
    session_id: 'session-uuid-test',
    tool_name: 'Bash',
    tool_input: '{"command":"npm test"}',
    status: 'pending' as const,
    created_at: new Date().toISOString(),
    resolved_at: null,
  },
} satisfies Record<string, Partial<Task> | Partial<Agent> | Partial<UserTerminal> | Record<string, unknown>>;

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
    `INSERT INTO tasks (id, title, description, repo_path, status, branch, base_branch, worktree, tmux_session, pr_url, pr_number, user_window_index, initial_prompt, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    task.user_window_index,
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
    'INSERT INTO agents (id, task_id, window_index, label, status, claude_session_id, hook_activity) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    agent.id,
    agent.task_id,
    agent.window_index,
    agent.label,
    agent.status,
    agent.claude_session_id,
    (agent as any).hook_activity || 'active',
  );

  return agent;
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function getAgents(db: Database.Database, taskId: string): Agent[] {
  return db.prepare('SELECT * FROM agents WHERE task_id = ?').all(taskId) as Agent[];
}

export function insertPermissionPrompt(
  db: Database.Database,
  overrides: Partial<typeof DEFAULTS.permissionPrompt> = {},
) {
  const pp = { ...DEFAULTS.permissionPrompt, ...overrides };
  db.prepare(
    `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pp.id,
    pp.task_id,
    pp.agent_id,
    pp.session_id,
    pp.tool_name,
    pp.tool_input,
    pp.status,
    pp.created_at,
    pp.resolved_at,
  );
  return pp;
}

export function getPermissionPrompts(db: Database.Database, taskId: string) {
  return db
    .prepare('SELECT * FROM permission_prompts WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Array<Record<string, unknown>>;
}

export function insertUserTerminal(
  db: Database.Database,
  overrides: Partial<UserTerminal> = {},
): UserTerminal {
  const ut: UserTerminal = { ...DEFAULTS.userTerminal, ...overrides } as UserTerminal;
  db.prepare(
    'INSERT INTO user_terminals (id, task_id, window_index, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ut.id, ut.task_id, ut.window_index, ut.label, ut.status, ut.created_at);
  return ut;
}

export function getUserTerminals(db: Database.Database, taskId: string): UserTerminal[] {
  return db
    .prepare('SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index')
    .all(taskId) as UserTerminal[];
}

// ─── Callback Finder ─────────────────────────────────────────────────────────

/**
 * Find the callback function in a variadic argument list (for promisified execFile mocks).
 * Searches from end to start since callbacks are typically last.
 */
export function findCallback(...args: any[]): Function | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i];
  }
  return undefined;
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

// ─── Agent Activity Helper ───────────────────────────────────────────────────

export function getAgentActivity(
  db: Database.Database,
  agentId: string,
): { hook_activity: string } {
  return db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get(agentId) as {
    hook_activity: string;
  };
}

// ─── Dead Session Mock ──────────────────────────────────────────────────────

/**
 * Creates an execFile mock implementation that simulates a dead tmux session.
 */
export function deadSessionMock(...args: any[]): any {
  const cb = findCallback(...args);
  if (cb) cb(new Error('session not found'));
  return undefined as any;
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
  'user_window_index',
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
  'claude_session_id',
  'hook_activity',
  'hook_activity_updated_at',
  'created_at',
];

export const PERMISSION_PROMPTS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'agent_id',
  'session_id',
  'tool_name',
  'tool_input',
  'status',
  'created_at',
  'resolved_at',
];

export const USER_TERMINALS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'window_index',
  'label',
  'status',
  'created_at',
];
