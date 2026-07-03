import type { Agent, Task, UserTerminal } from '@octomux/types';

// ─── Shared constants ─────────────────────────────────────────────────────────

export const FIXTURE_TIMESTAMP = '2026-01-01 00:00:00';
export const FIXTURE_TASK_ID = 'test-task-01';

/** DB-insert shape for permission_prompts — tool_input is stored as JSON text. */
export interface PermissionPromptFixture {
  id: string;
  task_id: string;
  agent_id: string | null;
  session_id: string;
  tool_name: string;
  tool_input: string;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

// ─── Agent fixtures ───────────────────────────────────────────────────────────

const AGENT_FIXTURE_BASE = {
  task_id: FIXTURE_TASK_ID,
  window_index: 0,
  label: 'Agent 1',
  status: 'running' as const,
  harness_id: 'claude-code',
  hook_token: '',
  hook_activity: 'active' as const,
  hook_activity_updated_at: null,
  tmux_session: null,
  agent: null,
  notify_agent_id: null,
  created_at: FIXTURE_TIMESTAMP,
} satisfies Omit<Agent, 'id' | 'harness_session_id'>;

/** Server test default — includes orchestrator-assigned session id. */
export const SERVER_AGENT_DEFAULTS: Agent = {
  ...AGENT_FIXTURE_BASE,
  id: 'test-agent-01',
  harness_session_id: 'test-session-uuid-01',
};

/** Frontend test default — harness issues session id at runtime. */
export const FRONTEND_AGENT_DEFAULTS: Agent = {
  ...AGENT_FIXTURE_BASE,
  id: 'agent-01',
  harness_session_id: null,
};

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return { ...FRONTEND_AGENT_DEFAULTS, ...overrides };
}

// ─── Task fixtures ────────────────────────────────────────────────────────────

const TASK_FIXTURE_BASE = {
  id: FIXTURE_TASK_ID,
  title: 'Fix order validation',
  description: 'Add negative quantity checks',
  pr_url: null,
  pr_number: null,
  pr_head_sha: null,
  user_window_index: null,
  initial_prompt: null,
  run_mode: 'new' as const,
  last_viewed_at: null,
  deleted_at: null,
  source: null,
  worktree_id: null,
  harness_id: 'claude-code',
  agent: null,
  model: null,
  notify_task_id: null,
  error: null,
  current_summary: null,
  current_summary_updated_at: null,
  created_at: FIXTURE_TIMESTAMP,
  updated_at: FIXTURE_TIMESTAMP,
} satisfies Omit<
  Task,
  | 'repo_path'
  | 'runtime_state'
  | 'workflow_status'
  | 'branch'
  | 'base_branch'
  | 'worktree'
  | 'tmux_session'
  | 'base_sha'
>;

/** Idle draft task — server integration tests. */
export const IDLE_TASK_FIXTURE: Task = {
  ...TASK_FIXTURE_BASE,
  repo_path: '/tmp/test-repo',
  runtime_state: 'idle',
  workflow_status: 'backlog',
  branch: null,
  base_branch: null,
  worktree: null,
  tmux_session: null,
  base_sha: null,
};

/** Running task with worktree — server integration tests. */
export const RUNNING_TASK_FIXTURE: Task = {
  ...TASK_FIXTURE_BASE,
  repo_path: '/tmp/test-repo',
  runtime_state: 'running',
  workflow_status: 'in_progress',
  branch: 'agents/fix-order-validation-test-t',
  base_branch: null,
  worktree: '/tmp/test-repo/.worktrees/fix-order-validation-test-t',
  tmux_session: 'octomux-agent-test-task-01',
  base_sha: 'abcdef0000000000000000000000000000000000',
};

/** Active task — frontend component tests. */
export const FRONTEND_TASK_DEFAULTS: Task = {
  ...TASK_FIXTURE_BASE,
  repo_path: '/Users/dev/projects/my-repo',
  runtime_state: 'running',
  workflow_status: 'in_progress',
  branch: 'agents/test-task-01',
  base_branch: null,
  worktree: '/Users/dev/projects/my-repo/.worktrees/test-task-01',
  tmux_session: 'octomux-agent-test-task-01',
  base_sha: null,
};

export function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...FRONTEND_TASK_DEFAULTS, ...overrides };
}

// ─── Other entity fixtures ────────────────────────────────────────────────────

export const USER_TERMINAL_FIXTURE: UserTerminal = {
  id: 'test-terminal-01',
  task_id: FIXTURE_TASK_ID,
  window_index: 2,
  label: 'Terminal 1',
  status: 'idle',
  created_at: FIXTURE_TIMESTAMP,
};

export const PERMISSION_PROMPT_FIXTURE: PermissionPromptFixture = {
  id: 'pp_test123456',
  task_id: 'task_test1234',
  agent_id: 'agent_test123',
  session_id: 'session-uuid-test',
  tool_name: 'Bash',
  tool_input: '{"command":"npm test"}',
  status: 'pending',
  created_at: new Date().toISOString(),
  resolved_at: null,
};

// ─── Derived path constants (server shell tests) ──────────────────────────────

export const SESSION_PREFIX = 'octomux-agent-';
export const BRANCH_PREFIX = 'agents/';
export const WORKTREE_DIR = '.worktrees';
