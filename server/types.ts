export type TaskStatus = 'draft' | 'setting_up' | 'running' | 'closed' | 'error';
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'stopped';
export type HookActivity = 'active' | 'idle' | 'waiting';
export type DerivedTaskStatus = 'working' | 'needs_attention' | 'done';

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
  user_window_index: number | null;
  initial_prompt: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  agents?: Agent[];
  pending_prompts?: PermissionPrompt[];
  derived_status?: DerivedTaskStatus | null;
}

export interface Agent {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: AgentStatus;
  claude_session_id: string | null;
  hook_activity: HookActivity;
  hook_activity_updated_at: string | null;
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
  repo_path: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
  draft?: boolean;
}

export interface OrchestratorStatus {
  running: boolean;
  session: string;
}

export interface AddAgentRequest {
  prompt?: string;
}

export interface UpdateTaskRequest {
  status?: 'closed' | 'running';
  title?: string;
  description?: string;
  repo_path?: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
}
