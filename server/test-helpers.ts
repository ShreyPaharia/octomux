import Database from 'better-sqlite3';
import { vi } from 'vitest';
import {
  IDLE_TASK_FIXTURE,
  RUNNING_TASK_FIXTURE,
  SERVER_AGENT_DEFAULTS,
  USER_TERMINAL_FIXTURE,
  PERMISSION_PROMPT_FIXTURE,
  SESSION_PREFIX,
  BRANCH_PREFIX,
  WORKTREE_DIR,
} from '@octomux/test-fixtures';
import { getDb, initDb, setDb } from './db.js';
import { SELECT_TASK_SQL } from './task-select.js';
import type { Task, Agent, UserTerminal } from './types.js';

// ─── Default Fixtures ────────────────────────────────────────────────────────

export const DEFAULTS = {
  task: IDLE_TASK_FIXTURE,
  runningTask: RUNNING_TASK_FIXTURE,
  agent: SERVER_AGENT_DEFAULTS,
  userTerminal: USER_TERMINAL_FIXTURE,
  permissionPrompt: PERMISSION_PROMPT_FIXTURE,
};

export { SESSION_PREFIX, BRANCH_PREFIX, WORKTREE_DIR };

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

  // Phase 2a: worktree/branch/base_branch/base_sha/repo_path/run_mode now live
  // on the worktrees table. Materialise a row only when the fixture supplies a
  // worktree path (or, for 'none' mode, a repo_path standing in as the path).
  let wtId: string | null = task.worktree_id ?? null;
  // Tests express "no worktree" by passing `worktree: null` explicitly; any
  // other shape (including the default repo_path) gets a row so joins work.
  const explicitlyNullWorktree = 'worktree' in overrides && overrides.worktree === null;
  const shouldCreateRow = !wtId && !explicitlyNullWorktree && (!!task.worktree || !!task.repo_path);
  if (shouldCreateRow) {
    wtId = `wt-${task.id}`;
    db.prepare(
      `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_use')`,
    ).run(
      wtId,
      task.worktree ?? task.repo_path ?? '',
      task.repo_path ?? null,
      task.branch ?? null,
      task.base_branch ?? null,
      task.base_sha ?? null,
      task.run_mode ?? 'new',
    );
  }

  // Use runtime_state directly from overrides or defaults.
  const runtimeState = (task as any).runtime_state ?? 'idle';

  // Use workflow_status directly from overrides or defaults.
  const workflowStatus = (task as any).workflow_status ?? 'backlog';

  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, tmux_session, pr_url, pr_number, pr_head_sha, user_window_index, initial_prompt, last_viewed_at, source, worktree_id, error, current_summary, current_summary_updated_at, notify_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.title,
    task.description,
    runtimeState,
    workflowStatus,
    task.tmux_session,
    task.pr_url,
    task.pr_number,
    task.pr_head_sha ?? null,
    task.user_window_index,
    task.initial_prompt,
    task.last_viewed_at ?? null,
    task.source ?? null,
    wtId,
    task.error,
    (task as any).current_summary ?? null,
    (task as any).current_summary_updated_at ?? null,
    (task as any).notify_task_id ?? null,
    task.created_at,
    task.updated_at,
  );

  // Echo joined shape back for assertions.
  task.worktree_id = wtId;
  return task;
}

export function insertAgent(db: Database.Database, overrides: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    ...DEFAULTS.agent,
    ...overrides,
  } as Agent;

  db.prepare(
    'INSERT INTO agents (id, task_id, window_index, label, status, harness_session_id, hook_activity, hook_token, notify_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    agent.id,
    agent.task_id,
    agent.window_index,
    agent.label,
    agent.status,
    (agent as any).harness_session_id ?? (agent as any).claude_session_id ?? null,
    (agent as any).hook_activity || 'active',
    (agent as any).hook_token ?? '',
    (agent as any).notify_agent_id ?? null,
  );

  return agent;
}

/**
 * Convenience wrapper around `insertTask` that uses the active DB
 * (set via `createTestDb` / `setDb`). Returns the joined `Task` shape.
 */
export function insertTestTask(overrides: Partial<Task> = {}): Task {
  return insertTask(getDb(), { ...DEFAULTS.runningTask, ...overrides });
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  return db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(id) as Task | undefined;
}

export function getAgents(db: Database.Database, taskId: string): Agent[] {
  return db.prepare('SELECT * FROM agents WHERE task_id = ?').all(taskId) as Agent[];
}

export function insertPermissionPrompt(
  db: Database.Database,
  overrides: Partial<Omit<typeof DEFAULTS.permissionPrompt, 'agent_id'>> & {
    agent_id?: string | null;
  } = {},
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
 * Strip the leading `-S <socket>` prefix that execTmux prepends to every tmux
 * invocation so that arg-matching helpers remain independent of the socket path.
 * Non-tmux calls (git, gh, …) are returned unchanged.
 */
function normalizeTmuxArgs(cmd: string, args: string[]): string[] {
  if (cmd === 'tmux' && args[0] === '-S') {
    // args = ['-S', '<path>', <subcommand>, ...]
    return args.slice(2);
  }
  return args;
}

/**
 * Find a matching call in the mocked execFile calls.
 * Returns the full call args or undefined.
 * For tmux calls, the leading `-S <socket>` prefix is transparently stripped
 * before matching so tests don't need to account for the private socket path.
 */
export function findExecCall(
  mock: ReturnType<typeof vi.fn>,
  match: ShellCallMatch,
): any[] | undefined {
  return mock.mock.calls.find((c: any[]) => {
    if (c[0] !== match.cmd) return false;
    const args = normalizeTmuxArgs(c[0] as string, c[1] as string[]);
    if (match.argsInclude && !match.argsInclude.every((a) => args?.includes(a))) return false;
    if (match.argsExclude && match.argsExclude.some((a) => args?.includes(a))) return false;
    return true;
  });
}

/**
 * Count matching calls in the mocked execFile calls.
 * For tmux calls, the leading `-S <socket>` prefix is transparently stripped.
 */
export function countExecCalls(mock: ReturnType<typeof vi.fn>, match: ShellCallMatch): number {
  return mock.mock.calls.filter((c: any[]) => {
    if (c[0] !== match.cmd) return false;
    const args = normalizeTmuxArgs(c[0] as string, c[1] as string[]);
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

// ─── execFile Callback Mocks ────────────────────────────────────────────────

/**
 * Creates an execFile mock implementation that calls back with (null, { stdout, stderr }).
 * Works with both promisify-style (opts as 3rd arg, cb as 4th) and direct callback style.
 */
export function execFileOk(stdout = '', stderr = ''): (...args: any[]) => any {
  return (...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(null, { stdout, stderr });
    return undefined as any;
  };
}

/**
 * Creates an execFile mock implementation that calls back with an error.
 * Works with both promisify-style (opts as 3rd arg, cb as 4th) and direct callback style.
 */
export function execFileFail(err: Error | string = 'exec failed'): (...args: any[]) => any {
  const error = typeof err === 'string' ? new Error(err) : err;
  return (...args: any[]) => {
    const cb = findCallback(...args);
    if (cb) cb(error);
    return undefined as any;
  };
}

/**
 * Creates an execFile mock implementation that simulates a dead tmux session.
 */
export const deadSessionMock = execFileFail('session not found');

// ─── Table-Driven Helpers ────────────────────────────────────────────────────

export const TASKS_TABLE_COLUMNS = [
  'id',
  'title',
  'description',
  'runtime_state',
  'workflow_status',
  'worktree_id',
  'tmux_session',
  'pr_url',
  'pr_number',
  'pr_head_sha',
  'user_window_index',
  'initial_prompt',
  'last_viewed_at',
  'source',
  'error',
  'current_summary',
  'current_summary_updated_at',
  'created_at',
  'updated_at',
  'agent',
  'model',
  'notify_task_id',
];

export const AGENTS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'window_index',
  'label',
  'status',
  'harness_session_id',
  'hook_activity',
  'hook_activity_updated_at',
  'tmux_session',
  'agent',
  'notify_agent_id',
  'created_at',
];

export const WORKTREES_TABLE_COLUMNS = [
  'id',
  'path',
  'repo_path',
  'branch',
  'base_branch',
  'base_sha',
  'mode',
  'status',
  'created_at',
  'last_used_at',
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

export const PR_EXTRACTS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'repo_path',
  'pr_number',
  'pr_head_sha',
  'area',
  'risk',
  'has_migration',
  'surface',
  'loc',
  'created_at',
];

export const USER_TERMINALS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'window_index',
  'label',
  'status',
  'created_at',
];
