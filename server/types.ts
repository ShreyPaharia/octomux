export * from '@octomux/types';

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
  deep_review_attached: number;
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

// ── Loop harness types ────────────────────────────────────────────────────

export type LoopEmitStatus = 'done' | 'blocked' | 'needs_human';
export type LoopRunStatus = 'running' | LoopEmitStatus;

export interface LoopRun {
  id: string;
  task_id: string;
  spec_json: string;
  status: LoopRunStatus;
  iteration: number;
  max_iterations: number | null;
  budget_json: string | null;
  termination_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoopIteration {
  id: string;
  loop_run_id: string;
  n: number;
  sha_from: string | null;
  sha_to: string | null;
  verify_passed: number | null;
  tokens: number | null;
  emit_status: string | null;
  emit_reason: string | null;
  created_at: string;
}

export interface LoopSpec {
  prompt: string;
  verify: string;
  maxIterations: number;
  budget?: { tokens?: number; timeMs?: number };
  noProgress?: { afterIters: number };
}

export type CommentBucket = 'actionable' | 'informational';
export type CommentSeverity = 'nit' | 'suggestion' | 'issue' | 'critical';
export type LastCheckStatus = 'resolved' | 'still_applies' | 'partial' | 'unclear';
