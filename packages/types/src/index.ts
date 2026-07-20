export type RuntimeState = 'idle' | 'setting_up' | 'running' | 'error' | 'looping';

/** PR-extract output contract — shared by server/routes/pr-extracts.ts (ajv validation) and the
 * client's schema-driven default detail view for the `pr-extract` workflow kind. */
export const PR_EXTRACT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['area', 'risk', 'has_migration', 'surface', 'loc'],
  properties: {
    area: { type: 'string', minLength: 1 },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    has_migration: { type: 'boolean' },
    surface: { type: 'string', minLength: 1 },
    loc: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;
/** Universal run-result envelope. Every workflow finishes its run with this shape; kind-specific
 * `output` schemas merge their own fields in alongside these keys. Stored as `runs.result_json`,
 * rendered by the unified /runs feed. See `spec/workflow-consolidation.md` §5. */
export interface RunResult {
  outcome: 'done' | 'blocked' | 'failed';
  /** Agent-authored prose: what happened. */
  summary: string;
  links?: { label: string; url: string }[];
  [key: string]: unknown;
}

/** Envelope keys every workflow `output` schema must require. Merge into kind-specific schemas
 * rather than validating separately — one ajv compile per kind, not two. */
export const RUN_RESULT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'string', minLength: 1 },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
} as const;

/** Type guard for the render path — `runs.result_json` is untrusted TEXT that predates this
 * envelope, so older rows will not match. Callers must also guard `JSON.parse` itself. */
export function isRunResult(v: unknown): v is RunResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.outcome === 'done' || o.outcome === 'blocked' || o.outcome === 'failed') &&
    typeof o.summary === 'string'
  );
}

/** Workflow status — human-facing board column. */
export type WorkflowStatus = 'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done';
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
] as const;

export type AgentStatus = 'running' | 'idle' | 'waiting' | 'stopped';
export type HookActivity = 'active' | 'idle' | 'waiting';
export type DerivedTaskStatus = 'working' | 'needs_attention' | 'done';

export type TaskSource = 'auto_review' | 'pr_extract' | 'prod_log_triage' | 'doc_drift' | null;

export type RunMode = 'new' | 'existing' | 'none' | 'scratch';

export const RUN_MODES: readonly RunMode[] = ['new', 'existing', 'none', 'scratch'] as const;

export type WorktreeStatus = 'available' | 'in_use';

export interface Worktree {
  id: string;
  path: string;
  repo_path: string | null;
  branch: string | null;
  base_branch: string | null;
  base_sha: string | null;
  mode: RunMode;
  status: WorktreeStatus;
  created_at: string;
  last_used_at: string | null;
}

/** Task joined with its worktree row — returned by GET /api/tasks/:id. */
export interface TaskWithWorktree extends Task {
  worktree_row: Worktree | null;
}

/** Aggregated worktree summary returned by GET /api/worktrees. */
export interface WorktreeSummary extends Worktree {
  task_count: number;
  active_task_id: string | null;
}

/** Request body for POST /api/chats — create a standalone runtime agent. */
export interface CreateChatRequest {
  label?: string;
  cwd?: string;
  agent?: string;
  prompt?: string;
  harness_id?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  repo_path: string;
  /** Tracks runtime lifecycle. */
  runtime_state: RuntimeState;
  /** Human-facing board column. */
  workflow_status: WorkflowStatus;
  branch: string | null;
  base_branch: string | null;
  worktree: string | null;
  tmux_session: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_head_sha: string | null;
  user_window_index: number | null;
  initial_prompt: string | null;
  run_mode: RunMode;
  base_sha: string | null;
  last_viewed_at: string | null;
  deleted_at: string | null;
  source: TaskSource;
  /** Phase 2a: link into the extracted `worktrees` table. Null = scratch/none during transition. */
  worktree_id: string | null;
  /** Optional agent name (matches `agents/<name>.md`); null launches plain `claude`. */
  agent: string | null;
  /** Optional per-task model override (e.g. 'claude-sonnet-4-6'). Overrides global flag. */
  model: string | null;
  /** If set, poller sends a completion message to this task's active agent when this task finishes. */
  notify_task_id: string | null;
  harness_id: string;
  error: string | null;
  /** Summary text set by agent or user. */
  current_summary: string | null;
  current_summary_updated_at: string | null;
  created_at: string;
  updated_at: string;
  agents?: Agent[];
  user_terminals?: UserTerminal[];
  pending_prompts?: PermissionPrompt[];
  derived_status?: DerivedTaskStatus | null;
  external_refs?: TaskExternalRef[];
  recent_updates?: TaskUpdate[];
  /** Live review task pointing at this source (or this PR). Set by GET /api/tasks/:id. */
  existing_review_id?: string | null;
}

export interface Agent {
  id: string;
  /** Phase 2a: null for standalone agents (orchestrator, chats). */
  task_id: string | null;
  window_index: number;
  label: string;
  status: AgentStatus;
  harness_id: string;
  harness_session_id: string | null;
  /** Per-agent token used to authenticate hook callbacks. */
  hook_token: string;
  hook_activity: HookActivity;
  hook_activity_updated_at: string | null;
  /** Phase 2a: populated for standalone agents; task-scoped agents read via task.tmux_session. */
  tmux_session: string | null;
  /** Optional agent name used at launch (`claude --agent <name>`). */
  agent: string | null;
  notify_agent_id: string | null;
  created_at: string;
}

export type UserTerminalStatus = 'idle' | 'working';

export interface UserTerminal {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: UserTerminalStatus;
  created_at: string;
}

export interface PermissionPrompt {
  id: string;
  task_id: string;
  agent_id: string | null;
  agent_label: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

export interface TaskExternalRef {
  task_id: string;
  integration: string;
  ref: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface TaskUpdate {
  id: string;
  task_id: string;
  agent_id: string | null;
  kind: 'transition' | 'summary' | 'note';
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  created_at: string;
}

export interface Integration {
  id: string;
  kind: string;
  name: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskRequest {
  title?: string;
  description?: string;
  repo_path?: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
  draft?: boolean;
  run_mode?: RunMode;
  worktree_path?: string;
  agent?: string;
  workflow_status?: WorkflowStatus;
  harness_id?: string;
  model?: string | null;
  notify_task_id?: string | null;
}

export interface AddAgentRequest {
  prompt?: string;
  agent?: string;
  label?: string;
  model?: string;
  skeleton?: string;
  notify_agent_id?: string | null;
}

export interface UpdateTaskRequest {
  runtime_state?: RuntimeState;
  workflow_status?: WorkflowStatus;
  title?: string;
  description?: string;
  repo_path?: string;
  branch?: string;
  base_branch?: string;
  initial_prompt?: string;
  run_mode?: RunMode;
  worktree_path?: string;
}

export interface MoveTaskRequest {
  workflow_status: WorkflowStatus;
  note?: string;
}

export interface SummaryRequest {
  summary: string;
}

export interface NoteRequest {
  body: string;
}

export interface AddRefRequest {
  integration: string;
  ref: string;
  url?: string;
  metadata?: Record<string, unknown> | null;
}

/** Request body for PATCH /api/tasks/:id/base — change a task's diff base. */
export interface UpdateTaskBaseRequest {
  base_branch: string;
}

export type { DiffRange } from '@octomux/diff-engine';

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
