import { createRequestCore, qs } from '@octomux/api-client';
import type {
  AddRefRequest,
  Agent,
  CreateTaskRequest,
  RunMode,
  Task,
  TaskExternalRef,
  TaskUpdate,
  UpdateTaskRequest,
  WorkflowStatus,
} from '@octomux/types';

export type { Agent, RunMode, Task, TaskExternalRef, TaskUpdate, WorkflowStatus };

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

export interface LoopSpecInput {
  prompt: string;
  verify: string;
  maxIterations: number;
  budget?: { tokens?: number; timeMs?: number };
  noProgress?: { afterIters: number };
}

export interface LoopRunResult {
  id: string;
  task_id: string;
  status: string;
  iteration: number;
  max_iterations: number | null;
  termination_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoopGroupResult {
  id: string;
  n: number;
  repo_path: string;
  base_branch: string;
  judge_status: string;
  winner_loop_run_id: string | null;
  judge_rationale: string | null;
  created_at: string;
  updated_at: string;
  loopRuns: LoopRunResult[];
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
  createTask(data: CreateTaskRequest & { title: string; description: string }): Promise<Task>;
  listTasks(params?: { repo_path?: string }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  updateTask(id: string, data: UpdateTaskRequest): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  addAgent(
    taskId: string,
    data?: {
      prompt?: string;
      agent?: string;
      label?: string;
      model?: string;
      skeleton?: string;
      notify_agent_id?: string | null;
    },
  ): Promise<Agent>;
  stopAgent(taskId: string, agentId: string): Promise<void>;
  startLoop(data: { taskId: string; spec: LoopSpecInput }): Promise<LoopRunResult>;
  startLoopGroup(data: {
    repoPath: string;
    baseBranch: string;
    spec: LoopSpecInput;
    n: number;
  }): Promise<LoopGroupResult>;
  sendMessage(taskId: string, agentId: string, message: string): Promise<{ success: boolean }>;
  listSkills(): Promise<{ name: string; description: string }[]>;
  getSkill(name: string): Promise<{ name: string; content: string }>;
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
  addTaskRef(taskId: string, data: AddRefRequest): Promise<TaskExternalRef>;
  deleteTaskRef(taskId: string, integration: string): Promise<void>;
  getTaskUpdates(taskId: string): Promise<{ updates: TaskUpdate[] }>;
  getTaskRefs(taskId: string): Promise<{ refs: TaskExternalRef[] }>;

  teamRun(data: { name: string; repo_path: string }): Promise<{ task_id: string }>;
  teamSchedule(data: { name: string; repo_path: string; cron: string }): Promise<{ ok: boolean }>;
  listTeams(): Promise<
    Array<{ name: string; cron: string; enabled: number; last_run_at: string | null }>
  >;

  listSavedFiles(repoPath: string): Promise<Array<{ path: string; size: number }>>;
  getSavedFile(repoPath: string, relPath: string): Promise<{ path: string; content: string }>;
  putSavedFile(
    repoPath: string,
    relPath: string,
    content: string,
  ): Promise<{ path: string; content: string }>;
}

function cliFetchError(err: unknown, { baseUrl }: { baseUrl: string }): never {
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

export function createClient(serverUrl: string): OctomuxClient {
  const baseUrl = serverUrl.replace(/\/$/, '') + '/api';
  const { request } = createRequestCore({
    baseUrl,
    alwaysJsonContentType: true,
    onFetchError: cliFetchError,
  });

  return {
    listIntegrations() {
      return request<IntegrationRow[]>('/integrations');
    },
    createTask(data) {
      return request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) });
    },
    listTasks(params) {
      // The dashboard board hides automated tasks (doc-drift, prod-log-triage, …) by default;
      // the CLI is an operator surface and must keep showing every task, as it always has.
      return request<Task[]>(
        `/tasks${qs({ repo_path: params?.repo_path, includeAutomated: 'true' })}`,
      );
    },
    getTask(id) {
      return request<Task>(`/tasks/${encodeURIComponent(id)}`);
    },
    updateTask(id, data) {
      return request<Task>(`/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },
    deleteTask(id) {
      return request<void>(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    addAgent(taskId, data) {
      return request<Agent>(`/tasks/${encodeURIComponent(taskId)}/agents`, {
        method: 'POST',
        body: JSON.stringify(data || {}),
      });
    },
    stopAgent(taskId, agentId) {
      return request<void>(
        `/tasks/${encodeURIComponent(taskId)}/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
      );
    },
    startLoop(data) {
      return request<LoopRunResult>('/loops', { method: 'POST', body: JSON.stringify(data) });
    },
    startLoopGroup(data) {
      return request<LoopGroupResult>('/loop-groups', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    sendMessage(taskId, agentId, message) {
      return request<{ success: boolean }>(
        `/tasks/${encodeURIComponent(taskId)}/agents/${encodeURIComponent(agentId)}/message`,
        { method: 'POST', body: JSON.stringify({ message }) },
      );
    },
    listSkills() {
      return request<{ name: string; description: string }[]>('/skills');
    },
    getSkill(name) {
      return request<{ name: string; content: string }>(`/skills/${encodeURIComponent(name)}`);
    },
    recentRepos() {
      return request<{ repo_path: string; last_used: string }[]>('/recent-repos');
    },
    defaultBranch(repoPath) {
      return request<{ branch: string }>(`/default-branch${qs({ repo_path: repoPath })}`);
    },
    getRepoConfig(repoPath) {
      return request(`/repo-config${qs({ repo_path: repoPath })}`);
    },
    postComment(taskId, data) {
      return request<InlineCommentRow>(`/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    listComments(taskId, file) {
      return request<{ comments: InlineCommentWithOutdated[]; outdated_unavailable?: boolean }>(
        `/tasks/${encodeURIComponent(taskId)}/comments${qs({ file })}`,
      );
    },
    updateComment(taskId, commentId, data) {
      return request<InlineCommentRow>(
        `/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      );
    },
    deleteComment(taskId, commentId) {
      return request<void>(
        `/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE' },
      );
    },
    moveTask(taskId, data) {
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/move`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    postTaskSummary(taskId, data) {
      return request<Task>(`/tasks/${encodeURIComponent(taskId)}/summary`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    postTaskNote(taskId, data) {
      return request<{ ok: boolean }>(`/tasks/${encodeURIComponent(taskId)}/note`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    addTaskRef(taskId, data) {
      return request<TaskExternalRef>(`/tasks/${encodeURIComponent(taskId)}/refs`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    deleteTaskRef(taskId, integration) {
      return request<void>(
        `/tasks/${encodeURIComponent(taskId)}/refs/${encodeURIComponent(integration)}`,
        { method: 'DELETE' },
      );
    },
    getTaskUpdates(taskId) {
      return request<{ updates: TaskUpdate[] }>(`/tasks/${encodeURIComponent(taskId)}/updates`);
    },
    getTaskRefs(taskId) {
      return request<{ refs: TaskExternalRef[] }>(`/tasks/${encodeURIComponent(taskId)}/refs`);
    },
    teamRun(data) {
      return request<{ task_id: string }>('/teams/run', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    teamSchedule(data) {
      return request<{ ok: boolean }>('/teams/schedule', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    listTeams() {
      return request<
        Array<{ name: string; cron: string; enabled: number; last_run_at: string | null }>
      >('/teams');
    },
    listSavedFiles(repoPath) {
      return request<{ path: string; size: number }[]>(
        `/repos/${encodeURIComponent(repoPath)}/files`,
      );
    },
    getSavedFile(repoPath, relPath) {
      return request<{ path: string; content: string }>(
        `/repos/${encodeURIComponent(repoPath)}/files/content${qs({ path: relPath })}`,
      );
    },
    putSavedFile(repoPath, relPath, content) {
      return request<{ path: string; content: string }>(
        `/repos/${encodeURIComponent(repoPath)}/files/content${qs({ path: relPath })}`,
        { method: 'PUT', body: JSON.stringify({ content }) },
      );
    },
  };
}
