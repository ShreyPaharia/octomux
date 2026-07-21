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

/**
 * A single ranked "look at this" — the pyramid's middle tier. Each highlight is
 * linked to specific code so the walkthrough summary and the diff stay welded.
 */
export interface WalkthroughHighlight {
  /** One-line "look at this" the reviewer actually needs to check. */
  title: string;
  /** Diff-relative file path this highlight points at (must exist in the diff). */
  file: string;
  /** Optional anchor line in `file`. */
  line?: number;
  /** Which side of the diff `line` refers to. */
  side?: 'old' | 'new';
  /** Optional one-sentence expansion, shown on demand. */
  detail?: string;
}

export interface Walkthrough {
  /** One-line verdict: what this PR does + its risk, in a sentence. */
  verdict: string;
  /** ≤5 ranked, code-linked highlights — the only things that actually matter. */
  highlights: WalkthroughHighlight[];
  global: {
    type: PRType;
    risk: 'low' | 'medium' | 'high';
    effort: 1 | 2 | 3 | 4 | 5;
    relevant_tests: 'yes' | 'no' | 'partial';
    security_concerns: string | null;
    ticket_compliance: TicketCompliance[];
    summary: string;
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
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Best-of-N loop group types ────────────────────────────────────────────

export type JudgeStatus = 'not_run' | 'running' | 'done' | 'error';

export interface LoopGroup {
  id: string;
  spec_json: string;
  n: number;
  repo_path: string;
  base_branch: string;
  judge_status: JudgeStatus;
  winner_loop_run_id: string | null;
  judge_rationale: string | null;
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
  /** The `runs.id` this loop's run row lives under — round-tripped through
   * spec_json (see `startLoop`) so the loop engine can `finishRun` it at
   * termination without a schema migration. */
  runId?: string;
}

// ── PR-extract workflow types ─────────────────────────────────────────────

export type PrExtractRisk = 'low' | 'medium' | 'high';

export interface PrExtract {
  id: string;
  task_id: string;
  repo_path: string;
  pr_number: number;
  pr_head_sha: string;
  area: string;
  risk: PrExtractRisk;
  has_migration: boolean;
  surface: string;
  loc: number;
  created_at: string;
}

export type CommentBucket = 'actionable' | 'informational';
export type CommentSeverity = 'nit' | 'suggestion' | 'issue' | 'critical';
export type LastCheckStatus = 'resolved' | 'still_applies' | 'partial' | 'unclear';
