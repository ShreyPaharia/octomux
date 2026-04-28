import type {
  Task,
  CreateTaskRequest,
  UpdateTaskRequest,
  AddAgentRequest,
  Agent,
  UserTerminal,
  Worktree,
  WorktreeSummary,
  TaskStatus,
} from '../../server/types';

export interface WorktreeDetail {
  worktree: Worktree;
  active_task: Task | null;
  history: Task[];
}

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

export interface AgentDefinition {
  name: string;
  description: string;
  isCustom: boolean;
}

export interface AgentDetail {
  name: string;
  content: string;
  defaultContent: string;
  isCustom: boolean;
}

export interface OctomuxSettings {
  editor: 'nvim' | 'vscode' | 'cursor';
  dangerouslySkipPermissions: boolean;
  claudeFlags: string;
  envOverrides?: {
    claudeFlags: string | null;
  };
}

export interface RepoConfig {
  repo_path: string;
  base_branch: string | null;
  test_command: string;
  format_command: string;
  lint_command: string;
  created_at: string;
  updated_at: string;
}

export interface PreflightConflict {
  task_id: string;
  title: string;
  status: TaskStatus;
  branch: string | null;
}

export interface PreflightResult {
  ok: boolean;
  currentBranch: string;
  targetBranch: string;
  conflicts: PreflightConflict[];
  dirty: { count: number } | null;
}

export type DiffFileStatus = 'A' | 'M' | 'D' | 'B';

export interface DiffFileEntry {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  ignored?: boolean;
  tooLarge?: boolean;
  binary?: boolean;
  post_blob_sha?: string | null;
  reviewed?: boolean;
  reviewed_at?: string | null;
  reviewed_at_commit?: string | null;
  changed_since_review?: boolean;
}

export interface DiffSummaryResponse {
  files: DiffFileEntry[];
  ignoredTruncated?: boolean;
  base_sha: string;
  base_ref: string;
  base_is_stale: boolean;
  reviewed_count: number;
  total_count: number;
}

export interface FileDiffResponse {
  oldContent: string;
  newContent: string;
  status: DiffFileStatus;
  tooLarge: boolean;
  binary: boolean;
}

export interface InboxResponse {
  needs_you: Task[];
  activity: Task[];
}

export const api = {
  browse: (path?: string) =>
    request<BrowseResult>(`/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  recentRepos: () => request<RecentRepo[]>('/recent-repos'),
  getInbox: () => request<InboxResponse>('/tasks/inbox'),
  markTaskViewed: (id: string) => request<Task>(`/tasks/${id}/viewed`, { method: 'PATCH' }),
  markAllTasksViewed: () => request<{ updated: number }>('/tasks/viewed-all', { method: 'POST' }),
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
  getTaskDiffSummary: (id: string) => request<DiffSummaryResponse>(`/tasks/${id}/diff`),
  createPr: (id: string, data: { title: string; body: string; draft?: boolean }) =>
    request<{ ok: boolean; url?: string; number?: number }>(`/tasks/${id}/pr`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getTaskDiffFile: (id: string, relPath: string) =>
    request<FileDiffResponse>(
      `/tasks/${id}/diff/${relPath.split('/').map(encodeURIComponent).join('/')}`,
    ),
  markReviewed: (taskId: string, filePath: string) =>
    request<void>(`/tasks/${taskId}/files/${filePath}/reviewed`, { method: 'POST' }),
  unmarkReviewed: (taskId: string, filePath: string) =>
    request<void>(`/tasks/${taskId}/files/${filePath}/reviewed`, { method: 'DELETE' }),
  addAgent: (taskId: string, data?: AddAgentRequest) =>
    request<Agent>(`/tasks/${taskId}/agents`, { method: 'POST', body: JSON.stringify(data || {}) }),
  stopAgent: (taskId: string, agentId: string) =>
    request<void>(`/tasks/${taskId}/agents/${agentId}`, { method: 'DELETE' }),
  createUserTerminal: (taskId: string) =>
    request<{ editor: string; windowIndex: number | null }>(`/tasks/${taskId}/user-terminal`, {
      method: 'POST',
    }),
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

  // Agents
  listAgents: () => request<AgentDefinition[]>('/agents'),
  getAgent: (name: string) => request<AgentDetail>(`/agents/${encodeURIComponent(name)}`),
  saveAgent: (name: string, content: string) =>
    request<AgentDetail>(`/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  resetAgent: (name: string) =>
    request<{ ok: boolean }>(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  createAgent: (data: { name: string; content: string }) =>
    request<AgentDetail>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  deleteAgent: (name: string) =>
    request<{ ok: boolean }>(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Agent task hopping (runtime agent row ← tasks table)
  moveAgentToTask: (agentId: string, taskId: string | null) =>
    request<Agent>(`/agents/${encodeURIComponent(agentId)}/task`, {
      method: 'PATCH',
      body: JSON.stringify({ task_id: taskId }),
    }),

  // Worktrees
  listWorktrees: () => request<WorktreeSummary[]>('/worktrees'),
  getWorktree: (id: string) => request<WorktreeDetail>(`/worktrees/${encodeURIComponent(id)}`),
  deleteWorktree: (id: string) =>
    request<void>(`/worktrees/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Repo Config
  listRepoConfigs: () => request<RepoConfig[]>('/repo-configs'),
  getRepoConfig: (repoPath: string) =>
    request<RepoConfig>(`/repo-config?repo_path=${encodeURIComponent(repoPath)}`),
  updateRepoConfig: (repoPath: string, updates: Partial<RepoConfig>) =>
    request<RepoConfig>('/repo-config', {
      method: 'PATCH',
      body: JSON.stringify({ repo_path: repoPath, ...updates }),
    }),

  // Preflight checks
  preflightNoneMode: (repoPath: string, baseBranch: string) =>
    request<PreflightResult>(
      `/preflight/none-mode?repo_path=${encodeURIComponent(repoPath)}&base_branch=${encodeURIComponent(baseBranch)}`,
    ),
  stashRepo: (repoPath: string, targetBranch: string) =>
    request<{ ok: true }>(`/preflight/stash`, {
      method: 'POST',
      body: JSON.stringify({ repo_path: repoPath, target_branch: targetBranch }),
    }),
};
