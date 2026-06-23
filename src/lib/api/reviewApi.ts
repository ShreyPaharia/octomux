/**
 * src/lib/api/reviewApi.ts
 *
 * Review-orchestrator API surface: review inbox, review detail, comment patches,
 * walkthroughs, publishing, re-review triggers, and review learnings. Mirrors the
 * per-domain routers under `server/routes/` (reviews, review-runs, learnings).
 */

import type { ReviewLearning } from '../../../server/types';
import { request } from './client';

// ─── Review orchestrator types ───────────────────────────────────────────────

export type ReviewInboxStatus =
  | 'reviewing'
  | 'drafts-ready'
  | 'head-advanced'
  | 'published'
  | 'failed';

export type PublishedReviewVerdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewInboxRow {
  task_id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_head_sha: string;
  author_login: string | null;
  repo_path: string;
  status: ReviewInboxStatus;
  draft_count: number;
  accepted_count: number;
  rejected_count: number;
  stale_count: number;
  last_activity_at: string;
}

export interface InlineCommentDTO {
  id: string;
  task_id: string;
  file_path: string;
  line: number;
  side: 'new' | 'old';
  body: string;
  status: 'draft' | 'accepted' | 'rejected' | 'published' | 'stale';
  kind: 'comment' | 'suggestion';
  severity: 'nit' | 'suggestion' | 'issue' | 'critical' | null;
  bucket: 'actionable' | 'informational' | null;
  existing_code: string | null;
  suggested_code: string | null;
  re_flag_of: string | null;
  auto_resolved_at: string | null;
  auto_resolved_reason: string | null;
  github_comment_id: number | null;
  review_run_id: string | null;
}

export interface ReviewCommentPatch {
  body?: string;
  severity?: 'nit' | 'suggestion' | 'issue' | 'critical';
  bucket?: 'actionable' | 'informational';
  status?: 'draft' | 'accepted' | 'rejected';
  kind?: 'comment' | 'suggestion';
  existing_code?: string;
  suggested_code?: string;
  rejection_why?: string;
}

export interface ReviewDetail {
  task: {
    id: string;
    title: string;
    pr_url: string;
    pr_head_sha: string;
    pr_number: number;
    repo_path: string;
  };
  latest_run: {
    id: string;
    pr_head_sha: string;
    walkthrough: string | null;
    status: string;
  } | null;
  all_runs: Array<{
    id: string;
    pr_head_sha: string;
    status: string;
    started_at: string;
    completed_at: string | null;
  }>;
  comments: InlineCommentDTO[];
  published_history: Array<{
    id: string;
    github_review_url: string | null;
    published_at: string;
    verdict: string;
    comment_count: number;
  }>;
}

export const reviewApi = {
  listReviewsInbox: () => request<ReviewInboxRow[]>('/reviews'),
  getReviewDetail: (taskId: string) => request<ReviewDetail>(`/reviews/${taskId}`),
  patchComment: (taskId: string, commentId: string, patch: ReviewCommentPatch) =>
    request<InlineCommentDTO>(`/tasks/${taskId}/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  patchWalkthrough: (taskId: string, runId: string, partial: Record<string, unknown>) =>
    request<{ walkthrough: string }>(`/tasks/${taskId}/review-runs/${runId}/walkthrough`, {
      method: 'PATCH',
      body: JSON.stringify(partial),
    }),
  publishReview: (taskId: string, payload: { verdict: PublishedReviewVerdict; body?: string }) =>
    request<{ publishedReviewId: string; github_review_url: string; commentCount: number }>(
      `/tasks/${taskId}/publish-review`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  requestReReview: (taskId: string) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/review-runs`, { method: 'POST' }),
  triggerManualReview: (taskId: string) =>
    request<{ id: string; action: 'created' | 'existing' }>(`/tasks/${taskId}/review`, {
      method: 'POST',
    }),

  // ─── Review learnings ─────────────────────────────────────────────────────
  listLearnings: (repoPath: string) =>
    request<ReviewLearning[]>(`/repos/${encodeURIComponent(repoPath)}/learnings`),
  deleteLearning: (id: string) =>
    request<void>(`/learnings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
