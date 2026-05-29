export type TaskStatus = 'draft' | 'setting_up' | 'running' | 'closed' | 'error';
/** New runtime state — replaces TaskStatus for the runtime column. */
export type RuntimeState = 'idle' | 'setting_up' | 'running' | 'error';
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

export type TaskSource = 'auto_review' | null;

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
}

export interface AddAgentRequest {
  prompt?: string;
  agent?: string;
}

export interface UpdateTaskRequest {
  status?: 'closed' | 'running';
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

/**
 * Diff range selector — what slice of history a diff query targets.
 * - `base`: full task diff (base..HEAD + working tree + untracked) — current default behavior
 * - `commit`: a single commit (sha^..sha)
 * - `range`: an arbitrary range (from..to)
 * - `working`: uncommitted changes vs HEAD only (no committed diff)
 */
export type DiffRange =
  | { kind: 'base' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'working' };

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

// ── Review orchestrator types ─────────────────────────────────────────────

export type PRType = 'Bug fix' | 'Tests' | 'Enhancement' | 'Documentation' | 'Other';

export type FileLabel =
  | 'bug fix'
  | 'tests'
  | 'enhancement'
  | 'documentation'
  | 'error handling'
  | 'configuration changes'
  | 'dependencies'
  | 'formatting'
  | 'miscellaneous';

export interface TicketCompliance {
  ticket: string;
  status: 'fully' | 'partially' | 'not' | 'no_ticket';
  reason?: string;
}

export interface Walkthrough {
  global: {
    type: PRType;
    risk: 'low' | 'medium' | 'high';
    effort: 1 | 2 | 3 | 4 | 5;
    relevant_tests: 'yes' | 'no' | 'partial';
    security_concerns: string | null;
    ticket_compliance: TicketCompliance[];
    summary: string;
    key_review_points: string[];
  };
  groups: Array<{
    name: string;
    summary: string;
    files: Array<{ path: string; label: FileLabel; summary: string }>;
  }>;
}

export type ReviewRunStatus = 'running' | 'completed' | 'failed';

export interface ReviewRun {
  id: string;
  task_id: string;
  pr_head_sha: string;
  walkthrough: string | null;
  status: ReviewRunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export type PublishedReviewVerdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface PublishedReview {
  id: string;
  task_id: string;
  github_review_id: number;
  github_review_url: string | null;
  head_sha: string;
  verdict: PublishedReviewVerdict;
  comment_count: number;
  published_at: string;
}

export interface ReviewLearning {
  id: string;
  repo_path: string;
  why: string;
  created_from_comment_id: string | null;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
}

export type CommentStatus = 'draft' | 'accepted' | 'rejected' | 'published' | 'stale';
export type CommentKind = 'comment' | 'suggestion';
export type CommentBucket = 'actionable' | 'informational';
export type CommentSeverity = 'nit' | 'suggestion' | 'issue' | 'critical';
export type LastCheckStatus = 'resolved' | 'still_applies' | 'partial' | 'unclear';
