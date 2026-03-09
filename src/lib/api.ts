import type { Task, CreateTaskRequest, UpdateTaskRequest, AddAgentRequest, Agent } from '../../server/types';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listTasks: () => request<Task[]>('/tasks'),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: CreateTaskRequest) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: UpdateTaskRequest) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTask: (id: string) =>
    request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  addAgent: (taskId: string, data?: AddAgentRequest) =>
    request<Agent>(`/tasks/${taskId}/agents`, { method: 'POST', body: JSON.stringify(data || {}) }),
  stopAgent: (taskId: string, agentId: string) =>
    request<void>(`/tasks/${taskId}/agents/${agentId}`, { method: 'DELETE' }),
};
