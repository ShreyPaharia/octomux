export type RunMode = 'new' | 'existing' | 'none' | 'scratch';

export type WorkflowStatus = 'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done';

export interface TaskUpdate {
  id: string;
  task_id: string;
  kind: string;
  payload: string | null;
  author: string | null;
  created_at: string;
}

export interface TaskExternalRef {
  task_id: string;
  integration: string;
  external_id: string;
  url: string | null;
  title: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  runtime_state: string;
  workflow_status: WorkflowStatus;
  repo_path: string;
  branch: string | null;
  base_branch: string | null;
  worktree: string | null;
  pr_url: string | null;
  pr_number: number | null;
  initial_prompt: string | null;
  run_mode: RunMode;
  base_sha: string | null;
  last_viewed_at: string | null;
  current_summary: string | null;
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
  harness_id: string;
  harness_session_id: string | null;
  hook_token: string;
  hook_activity: string;
  created_at: string;
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

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  /** Secret fields (api_token / api_key) are masked by the server. */
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface OctomuxClient {
  listIntegrations(): Promise<IntegrationRow[]>;
  createTask(data: {
    title: string;
    description: string;
    repo_path?: string;
    initial_prompt?: string;
    branch?: string;
    base_branch?: string;
    draft?: boolean;
    run_mode?: RunMode;
    worktree_path?: string;
    harness_id?: string;
    model?: string | null;
  }): Promise<Task>;
  listTasks(params?: { repo_path?: string }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  updateTask(id: string, data: { status: string }): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addAgent(
    taskId: string,
    data?: { prompt?: string; agent?: string; label?: string; model?: string },
  ): Promise<Agent>;
  stopAgent(taskId: string, agentId: string): Promise<void>;
  sendMessage(taskId: string, agentId: string, message: string): Promise<{ success: boolean }>;
  listSkills(): Promise<{ name: string; description: string }[]>;
  getSkill(name: string): Promise<{ name: string; content: string }>;
  createSkill(data: { name: string; content: string }): Promise<{ name: string; content: string }>;
  deleteSkill(name: string): Promise<void>;
  recentRepos(): Promise<{ repo_path: string; last_used: string }[]>;
  defaultBranch(repoPath: string): Promise<{ branch: string }>;
  getRepoConfig(repoPath: string): Promise<{
    repo_path: string;
    base_branch: string | null;
    test_command: string;
    format_command: string;
    lint_command: string;
  }>;
  postComment(taskId: string, data: PostCommentInput): Promise<InlineCommentRow>;
  listComments(
    taskId: string,
    file?: string,
  ): Promise<{ comments: InlineCommentWithOutdated[]; outdated_unavailable?: boolean }>;
  updateComment(
    taskId: string,
    commentId: string,
    data: { resolved?: boolean; body?: string },
  ): Promise<InlineCommentRow>;
  deleteComment(taskId: string, commentId: string): Promise<void>;
  moveTask(taskId: string, data: { workflow_status: WorkflowStatus; note?: string }): Promise<Task>;
  postTaskSummary(taskId: string, data: { summary: string; author?: string }): Promise<Task>;
  postTaskNote(taskId: string, data: { note: string; author?: string }): Promise<{ ok: boolean }>;
  addTaskRef(
    taskId: string,
    data: {
      integration: string;
      external_id: string;
      url?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<TaskExternalRef>;
  deleteTaskRef(taskId: string, integration: string): Promise<void>;
  getTaskUpdates(taskId: string): Promise<{ updates: TaskUpdate[] }>;
  getTaskRefs(taskId: string): Promise<{ refs: TaskExternalRef[] }>;

  teamRun(data: { name: string; repo_path: string }): Promise<{ task_id: string }>;
  teamSchedule(data: { name: string; repo_path: string; cron: string }): Promise<{ ok: boolean }>;
  listTeams(): Promise<
    Array<{ name: string; cron: string; enabled: number; last_run_at: string | null }>
  >;
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
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
      throw new Error(
        `Cannot connect to octomux server at ${baseUrl.replace('/api', '')}\nStart it with: octomux start`,
      );
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
    listIntegrations() {
      return request<IntegrationRow[]>(baseUrl, '/integrations');
    },
    createTask(data) {
      return request<Task>(baseUrl, '/tasks', { method: 'POST', body: JSON.stringify(data) });
    },
    listTasks(params) {
      return request<Task[]>(baseUrl, `/tasks${qs({ repo_path: params?.repo_path })}`);
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
    stopAgent(taskId, agentId) {
      return request<void>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
      );
    },
    sendMessage(taskId, agentId, message) {
      return request<{ success: boolean }>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/agents/${encodeURIComponent(agentId)}/message`,
        { method: 'POST', body: JSON.stringify({ message }) },
      );
    },
    listSkills() {
      return request<{ name: string; description: string }[]>(baseUrl, '/skills');
    },
    getSkill(name) {
      return request<{ name: string; content: string }>(
        baseUrl,
        `/skills/${encodeURIComponent(name)}`,
      );
    },
    createSkill(data) {
      return request<{ name: string; content: string }>(baseUrl, '/skills', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteSkill(name) {
      return request<void>(baseUrl, `/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
    recentRepos() {
      return request<{ repo_path: string; last_used: string }[]>(baseUrl, '/recent-repos');
    },
    defaultBranch(repoPath) {
      return request<{ branch: string }>(baseUrl, `/default-branch${qs({ repo_path: repoPath })}`);
    },
    getRepoConfig(repoPath) {
      return request(baseUrl, `/repo-config${qs({ repo_path: repoPath })}`);
    },
    postComment(taskId, data) {
      return request<InlineCommentRow>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    listComments(taskId, file) {
      return request<{ comments: InlineCommentWithOutdated[]; outdated_unavailable?: boolean }>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/comments${qs({ file })}`,
      );
    },
    updateComment(taskId, commentId, data) {
      return request<InlineCommentRow>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      );
    },
    deleteComment(taskId, commentId) {
      return request<void>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE' },
      );
    },
    moveTask(taskId, data) {
      return request<Task>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/move`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    postTaskSummary(taskId, data) {
      return request<Task>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/summary`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    postTaskNote(taskId, data) {
      return request<{ ok: boolean }>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/note`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    addTaskRef(taskId, data) {
      return request<TaskExternalRef>(baseUrl, `/tasks/${encodeURIComponent(taskId)}/refs`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteTaskRef(taskId, integration) {
      return request<void>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/refs/${encodeURIComponent(integration)}`,
        { method: 'DELETE' },
      );
    },
    getTaskUpdates(taskId) {
      return request<{ updates: TaskUpdate[] }>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/updates`,
      );
    },
    getTaskRefs(taskId) {
      return request<{ refs: TaskExternalRef[] }>(
        baseUrl,
        `/tasks/${encodeURIComponent(taskId)}/refs`,
      );
    },
    teamRun(data) {
      return request<{ task_id: string }>(baseUrl, '/teams/run', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    teamSchedule(data) {
      return request<{ ok: boolean }>(baseUrl, '/teams/schedule', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    listTeams() {
      return request<
        Array<{ name: string; cron: string; enabled: number; last_run_at: string | null }>
      >(baseUrl, '/teams');
    },
  };
}
