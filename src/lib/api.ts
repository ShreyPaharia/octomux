import type {
  Task,
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Agent,
  OrchestratorStatus,
  UserTerminal,
} from '../../server/types';

const BASE = '/api';

// In-flight GET request deduplication: if the same GET is already pending,
// reuse its promise instead of firing a duplicate network request.
const inflight = new Map<string, Promise<unknown>>();

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method || 'GET';

  // Only deduplicate GET requests — mutations must always execute
  if (method === 'GET') {
    const key = `GET:${path}`;
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = doRequest<T>(path, options).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return doRequest<T>(path, options);
}

async function doRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
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

export interface BrowseResult {
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; isGit: boolean }>;
}

export interface RecentRepo {
  repo_path: string;
  last_used: string;
}

export interface Skill {
  name: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  content: string;
}

export interface OrchestratorPromptData {
  content: string;
  default: string;
  isCustom: boolean;
}

export interface OctomuxSettings {
  editor: 'nvim' | 'vscode' | 'cursor';
}

export const api = {
  browse: (path?: string) =>
    request<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  recentRepos: () => request<RecentRepo[]>('/recent-repos'),
  listBranches: (repoPath: string) =>
    request<string[]>(`/branches?repo_path=${encodeURIComponent(repoPath)}`),
  getDefaultBranch: (repoPath: string) =>
    request<{ branch: string }>(`/default-branch?repo_path=${encodeURIComponent(repoPath)}`),
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
  createUserTerminal: (taskId: string) =>
    request<{ user_window_index: number }>(`/tasks/${taskId}/user-terminal`, { method: 'POST' }),
  createTerminal: (taskId: string) =>
    request<UserTerminal>(`/tasks/${taskId}/terminals`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  closeTerminal: (taskId: string, terminalId: string) =>
    request<void>(`/tasks/${taskId}/terminals/${terminalId}`, { method: 'DELETE' }),

  getSettings: () => request<OctomuxSettings>('/settings'),
  updateSettings: (data: Partial<OctomuxSettings>) =>
    request<OctomuxSettings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  orchestratorStatus: () => request<OrchestratorStatus>('/orchestrator/status'),
  orchestratorStart: () => request<OrchestratorStatus>('/orchestrator/start', { method: 'POST' }),
  orchestratorStop: () => request<void>('/orchestrator/stop', { method: 'POST' }),
  orchestratorSend: (message: string) =>
    request<{ ok: boolean; running: boolean }>('/orchestrator/send', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  orchestratorType: (message: string) =>
    request<{ ok: boolean; running: boolean }>('/orchestrator/type', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Orchestrator Prompt
  getOrchestratorPrompt: () => request<OrchestratorPromptData>('/orchestrator/prompt'),
  updateOrchestratorPrompt: (content: string) =>
    request<{ ok: boolean; isCustom: boolean }>('/orchestrator/prompt', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  resetOrchestratorPrompt: () =>
    request<{ ok: boolean; isCustom: boolean }>('/orchestrator/prompt', { method: 'DELETE' }),

  // Skills
  listSkills: () => request<Skill[]>('/skills'),
  getSkill: (name: string) => request<SkillDetail>(`/skills/${encodeURIComponent(name)}`),
  createSkill: (data: { name: string; content: string }) =>
    request<SkillDetail>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  updateSkill: (name: string, data: { content: string }) =>
    request<SkillDetail>(`/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteSkill: (name: string) =>
    request<void>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
