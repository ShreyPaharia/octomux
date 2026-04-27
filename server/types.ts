export type TaskStatus = 'draft' | 'setting_up' | 'running' | 'closed' | 'error';
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'stopped';
export type HookActivity = 'active' | 'idle' | 'waiting';
export type DerivedTaskStatus = 'working' | 'needs_attention' | 'done';

export type TaskSource = 'auto_review' | null;

export type RunMode = 'new' | 'existing' | 'none' | 'scratch';

export const RUN_MODES: readonly RunMode[] = ['new', 'existing', 'none', 'scratch'] as const;

export type WorktreeStatus = 'available' | 'in_use';

export interface Worktree {
  id: string;
  path: string;
  repo_path: string | null;
  branch: string | null;
  base_branch: string | null;
  base_sha: string | null;
  mode: RunMode;
  status: WorktreeStatus;
  created_at: string;
  last_used_at: string | null;
}

/** Task joined with its worktree row — returned by GET /api/tasks/:id. */
export interface TaskWithWorktree extends Task {
  worktree_row: Worktree | null;
}

/** Aggregated worktree summary returned by GET /api/worktrees. */
export interface WorktreeSummary extends Worktree {
  task_count: number;
  active_task_id: string | null;
}

/** Request body for POST /api/chats — create a standalone runtime agent. */
export interface CreateChatRequest {
  label?: string;
  cwd?: string;
  agent?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  repo_path: string;
  status: TaskStatus;
  branch: string | null;
  base_branch: string | null;
  worktree: string | null;
  tmux_session: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_head_sha: string | null;
  user_window_index: number | null;
  initial_prompt: string | null;
  run_mode: RunMode;
  base_sha: string | null;
  last_viewed_at: string | null;
  source: TaskSource;
  /** Phase 2a: link into the extracted `worktrees` table. Null = scratch/none during transition. */
  worktree_id: string | null;
  /** Optional agent name (matches `agents/<name>.md`); null launches plain `claude`. */
  agent: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  agents?: Agent[];
  user_terminals?: UserTerminal[];
  pending_prompts?: PermissionPrompt[];
  derived_status?: DerivedTaskStatus | null;
}

export interface Agent {
  id: string;
  /** Phase 2a: null for standalone agents (orchestrator, chats). */
  task_id: string | null;
  window_index: number;
  label: string;
  status: AgentStatus;
  claude_session_id: string | null;
  hook_activity: HookActivity;
  hook_activity_updated_at: string | null;
  /** Phase 2a: populated for standalone agents; task-scoped agents read via task.tmux_session. */
  tmux_session: string | null;
  /** Optional agent name used at launch (`claude --agent <name>`). */
  agent: string | null;
  created_at: string;
}

export type UserTerminalStatus = 'idle' | 'working';

export interface UserTerminal {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: UserTerminalStatus;
  created_at: string;
}

export interface PermissionPrompt {
  id: string;
  task_id: string;
  agent_id: string | null;
  agent_label: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

export interface CreateTaskRequest {
  title: string;
  description: string;
  repo_path?: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
  draft?: boolean;
  run_mode?: RunMode;
  worktree_path?: string;
  agent?: string;
}

export interface AddAgentRequest {
  prompt?: string;
  agent?: string;
}

export interface UpdateTaskRequest {
  status?: 'closed' | 'running';
  title?: string;
  description?: string;
  repo_path?: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
  run_mode?: RunMode;
  worktree_path?: string;
}
