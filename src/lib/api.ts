import type {
  Task,
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Agent,
  OrchestratorStatus,
} from '../../server/types';

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

export interface BrowseResult {
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; isGit: boolean }>;
}

export interface RecentRepo {
  repo_path: string;
  last_used: string;
}

export const api = {
  browse: (path?: string) =>
    request<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  recentRepos: () => request<RecentRepo[]>('/recent-repos'),
  listTasks: () => request<Task[]>('/tasks'),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: CreateTaskRequest) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: UpdateTaskRequest) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  startTask: (id: string) => request<Task>(`/tasks/${id}/start`, { method: 'POST' }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  addAgent: (taskId: string, data?: AddAgentRequest) =>
    request<Agent>(`/tasks/${taskId}/agents`, { method: 'POST', body: JSON.stringify(data || {}) }),
  stopAgent: (taskId: string, agentId: string) =>
    request<void>(`/tasks/${taskId}/agents/${agentId}`, { method: 'DELETE' }),
  previewPR: (taskId: string, data: { base: string }) =>
    request<{ title: string; body: string; base: string }>(`/tasks/${taskId}/pr/preview`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createPR: (taskId: string, data: { base: string; title: string; body: string }) =>
    request<Task>(`/tasks/${taskId}/pr`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  orchestratorStatus: () => request<OrchestratorStatus>('/orchestrator/status'),
  orchestratorStart: () => request<OrchestratorStatus>('/orchestrator/start', { method: 'POST' }),
  orchestratorStop: () => request<void>('/orchestrator/stop', { method: 'POST' }),
};
