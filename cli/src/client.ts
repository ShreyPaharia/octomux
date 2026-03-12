export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  repo_path: string;
  branch: string | null;
  base_branch: string | null;
  worktree: string | null;
  pr_url: string | null;
  pr_number: number | null;
  initial_prompt: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  agents?: Agent[];
  pending_prompts?: unknown[];
  derived_status?: string | null;
}

export interface Agent {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: string;
  claude_session_id: string | null;
  hook_activity: string;
  created_at: string;
}

export interface OctomuxClient {
  createTask(data: {
    title: string;
    description: string;
    repo_path: string;
    initial_prompt?: string;
    branch?: string;
    base_branch?: string;
    draft?: boolean;
  }): Promise<Task>;
  listTasks(params?: { repo_path?: string }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  updateTask(id: string, data: { status: string }): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addAgent(taskId: string, data?: { prompt?: string }): Promise<Agent>;
}

async function request<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).cause &&
      ((err as NodeJS.ErrnoException).cause as NodeJS.ErrnoException).code === 'ECONNREFUSED'
    ) {
      throw new Error(`Cannot connect to octomux server at ${baseUrl}. Is it running?`);
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function createClient(serverUrl: string): OctomuxClient {
  const baseUrl = serverUrl.replace(/\/$/, '') + '/api';

  return {
    createTask(data) {
      return request<Task>(baseUrl, '/tasks', { method: 'POST', body: JSON.stringify(data) });
    },
    listTasks(params) {
      const query = params?.repo_path
        ? `?repo_path=${encodeURIComponent(params.repo_path)}`
        : '';
      return request<Task[]>(baseUrl, `/tasks${query}`);
    },
    getTask(id) {
      return request<Task>(baseUrl, `/tasks/${encodeURIComponent(id)}`);
    },
    updateTask(id, data) {
      return request<Task>(baseUrl, `/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    deleteTask(id) {
      return request<void>(baseUrl, `/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    addAgent(taskId, data) {
      return request<Agent>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/agents`, {
        method: 'POST',
        body: JSON.stringify(data || {}),
      });
    },
  };
}
