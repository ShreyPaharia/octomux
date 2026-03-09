export type TaskStatus = 'created' | 'setting_up' | 'running' | 'done' | 'cancelled' | 'error';
export type AgentStatus = 'running' | 'idle' | 'waiting' | 'stopped';

export interface Task {
  id: string;
  title: string;
  description: string;
  repo_path: string;
  status: TaskStatus;
  branch: string | null;
  worktree: string | null;
  tmux_session: string | null;
  pr_url: string | null;
  pr_number: number | null;
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
  created_at: string;
}

export interface CreateTaskRequest {
  title: string;
  description: string;
  repo_path: string;
}

export interface AddAgentRequest {
  prompt?: string;
}

export interface UpdateTaskRequest {
  status?: 'done' | 'cancelled';
}
