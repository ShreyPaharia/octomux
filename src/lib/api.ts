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
  WorkflowStatus,
  RuntimeState,
  TaskExternalRef,
  TaskUpdate,
  MoveTaskRequest,
  SummaryRequest,
  NoteRequest,
  AddRefRequest,
} from '../../server/types';

export type { WorkflowStatus, RuntimeState, TaskExternalRef, TaskUpdate };

/**
 * Back-compat adapter: the old UI expects `task.status` to contain
 * 'draft'|'setting_up'|'running'|'closed'|'error'. After the wave-1 rename,
 * the server returns `runtime_state` and `workflow_status`.  Map runtime_state
 * back to a legacy TaskStatus so existing TaskCard/TaskFilterBar still work
 * without changes.
 *
 * Call this on every Task returned by the server before handing it to
 * existing React components.
 */
export function adaptTask(raw: Task): Task & { status: TaskStatus } {
  const runtimeState: RuntimeState = raw.runtime_state ?? 'idle';
  let legacyStatus: TaskStatus;
  switch (runtimeState) {
    case 'setting_up': legacyStatus = 'setting_up'; break;
    case 'running':    legacyStatus = 'running'; break;
    case 'error':      legacyStatus = 'error'; break;
    case 'idle':
    default:
      // Was this a draft (no initial_prompt + never started) or closed?
      legacyStatus = raw.status === 'draft' ? 'draft' : 'closed';
  }
  return {
    ...raw,
    status: legacyStatus,
    runtime_state: runtimeState,
  };
}

export function adaptTasks(raws: Task[]): Task[] {
  return raws.map(adaptTask);
}

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
  /** Active none-mode tasks on the same root worktree, on a *different* branch. Blocks creation. */
  conflicts: PreflightConflict[];
  /** Active none-mode tasks on the same root worktree, on the *same* branch. Non-blocking. */
  warnings: PreflightConflict[];
  dirty: { count: number } | null;
}

export type DiffRange =
  | { kind: 'base' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'working' };

export function diffRangeToParam(range: DiffRange | undefined): string | null {
  if (!range || range.kind === 'base') return null;
  if (range.kind === 'working') return 'working';
  if (range.kind === 'commit') return `commit:${range.sha}`;
  return `range:${range.from}..${range.to}`;
}

export interface TaskCommit {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  author_email: string;
  authored_at: string;
}

export interface ListTaskCommitsResponse {
  commits: TaskCommit[];
  truncated: boolean;
}

export interface ListTaskBranchesResponse {
  branches: string[];
  current: string | null;
  default: string | null;
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
  isDirectory: boolean;
}

export interface InboxResponse {
  needs_you: Task[];
  activity: Task[];
}

export interface InlineCommentRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
}

export interface InlineCommentWithOutdated extends InlineCommentRow {
  outdated: boolean;
}

export interface PostCommentInput {
  file_path: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  agent_id?: string;
  anchor_commit_sha?: string;
}

export interface ListCommentsResponse {
  comments: InlineCommentWithOutdated[];
  outdated_unavailable?: boolean;
}

export interface UpdateCommentInput {
  resolved?: boolean;
  body?: string;
}

// ─── Integrations types (Wave 2B) ────────────────────────────────────────────

export interface IntegrationProvider {
  kind: string;
  displayName: string;
  configSchema: Record<string, unknown>;
  events: string[];
}

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
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
  getTaskDiffSummary: (id: string, range?: DiffRange) => {
    const param = diffRangeToParam(range);
    const qs = param ? `?range=${encodeURIComponent(param)}` : '';
    return request<DiffSummaryResponse>(`/tasks/${id}/diff${qs}`);
  },
  createPr: (id: string, data: { title: string; body: string; draft?: boolean }) =>
    request<{ ok: boolean; url?: string; number?: number }>(`/tasks/${id}/pr`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getTaskDiffFile: (id: string, relPath: string, range?: DiffRange) => {
    const param = diffRangeToParam(range);
    const qs = param ? `?range=${encodeURIComponent(param)}` : '';
    return request<FileDiffResponse>(
      `/tasks/${id}/diff/${relPath.split('/').map(encodeURIComponent).join('/')}${qs}`,
    );
  },
  listTaskBranches: (id: string) => request<ListTaskBranchesResponse>(`/tasks/${id}/branches`),
  listTaskCommits: (id: string, opts?: { range?: DiffRange; limit?: number }) => {
    const sp = new URLSearchParams();
    const param = diffRangeToParam(opts?.range);
    if (param) sp.set('range', param);
    if (opts?.limit) sp.set('limit', String(opts.limit));
    const qs = sp.toString();
    return request<ListTaskCommitsResponse>(`/tasks/${id}/commits${qs ? `?${qs}` : ''}`);
  },
  updateTaskBase: (id: string, baseBranch: string) =>
    request<Task>(`/tasks/${id}/base`, {
      method: 'PATCH',
      body: JSON.stringify({ base_branch: baseBranch }),
    }),
  markReviewed: (taskId: string, filePath: string) =>
    request<void>(`/tasks/${taskId}/files/${filePath}/reviewed`, { method: 'POST' }),
  unmarkReviewed: (taskId: string, filePath: string) =>
    request<void>(`/tasks/${taskId}/files/${filePath}/reviewed`, { method: 'DELETE' }),
  postComment: (taskId: string, data: PostCommentInput) =>
    request<InlineCommentRow>(`/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listComments: (taskId: string, file?: string) => {
    const qs = file ? `?file=${encodeURIComponent(file)}` : '';
    return request<ListCommentsResponse>(`/tasks/${taskId}/comments${qs}`);
  },
  updateComment: (taskId: string, commentId: string, data: UpdateCommentInput) =>
    request<InlineCommentRow>(`/tasks/${taskId}/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteComment: (taskId: string, commentId: string) =>
    request<void>(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' }),
  sendAgentMessage: (taskId: string, agentId: string, message: string) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/agents/${agentId}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
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

  // Workflow endpoints
  moveTask: (id: string, data: MoveTaskRequest) =>
    request<Task>(`/tasks/${id}/move`, { method: 'POST', body: JSON.stringify(data) }),
  postTaskSummary: (id: string, data: SummaryRequest) =>
    request<Task>(`/tasks/${id}/summary`, { method: 'POST', body: JSON.stringify(data) }),
  postTaskNote: (id: string, data: NoteRequest) =>
    request<TaskUpdate>(`/tasks/${id}/note`, { method: 'POST', body: JSON.stringify(data) }),
  addTaskRef: (id: string, data: AddRefRequest) =>
    request<TaskExternalRef>(`/tasks/${id}/refs`, { method: 'POST', body: JSON.stringify(data) }),
  deleteTaskRef: (id: string, integration: string) =>
    request<void>(`/tasks/${id}/refs/${encodeURIComponent(integration)}`, { method: 'DELETE' }),
  getTaskUpdates: (id: string, limit?: number) =>
    request<TaskUpdate[]>(`/tasks/${id}/updates${limit ? `?limit=${limit}` : ''}`),
  getTaskRefs: (id: string) => request<TaskExternalRef[]>(`/tasks/${id}/refs`),

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

  // Chats (standalone runtime agents)
  listChats: () => request<Agent[]>('/chats'),
  closeChat: (id: string) =>
    request<Agent>(`/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'stopped' }),
    }),
  deleteChat: (id: string) =>
    request<void>(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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

  // ─── Integrations (Wave 2B) ──────────────────────────────────────────────────

  listProviders: () => request<IntegrationProvider[]>('/integrations/providers'),
  listIntegrations: () => request<IntegrationRow[]>('/integrations'),
  createIntegration: (kind: string, name: string, config: Record<string, unknown>) =>
    request<IntegrationRow>('/integrations', {
      method: 'POST',
      body: JSON.stringify({ kind, name, config }),
    }),
  updateIntegration: (
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
  ) =>
    request<IntegrationRow>(`/integrations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteIntegration: (id: string) =>
    request<void>(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testIntegration: (id: string) =>
    request<{ ok: boolean; message: string }>(
      `/integrations/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
};
