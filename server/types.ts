export type TaskStatus = 'draft' | 'setting_up' | 'running' | 'closed' | 'error';
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'stopped';

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
}

export interface Agent {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: AgentStatus;
  claude_session_id: string | null;
  created_at: string;
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
}
