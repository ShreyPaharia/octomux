const BASE_URL = process.env.OCTOMUX_URL || 'http://localhost:7777/api';

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface Task {
  id: string;
  title: string;
  status: string;
  repo_path: string;
  branch: string | null;
  pr_url: string | null;
  created_at: string;
}

export function createTask(data: {
  title: string;
  description: string;
  repo_path: string;
  initial_prompt?: string;
  branch?: string;
  base_branch?: string;
}): Promise<Task> {
  return request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) });
}

export function listTasks(): Promise<Task[]> {
  return request<Task[]>('/tasks');
}

export function getTask(id: string): Promise<Task> {
  return request<Task>(`/tasks/${id}`);
}

export function updateTask(id: string, data: { status: string }): Promise<Task> {
  return request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
