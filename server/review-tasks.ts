import path from 'path';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';

/** Lowercased, dashed `basename(repoPath)` — safe for use in branch names. */
export function repoShortName(repoPath: string): string {
  return (
    path
      .basename(repoPath)
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .toLowerCase() || 'repo'
  );
}

export interface PrReviewPromptInput {
  title: string;
  number: number;
  url: string;
  author?: string | null;
  headRefOid: string;
  requestedAt: string;
}

/** Prompt used when the source has an open PR — same shape the poller emits. */
export function buildPrReviewPrompt(input: PrReviewPromptInput): string {
  const author = input.author ?? 'unknown';
  return [
    `/review-orchestrator`,
    '',
    `PR: ${input.title} (#${input.number}) by @${author}`,
    `URL: ${input.url}`,
    `Head: ${input.headRefOid}`,
    `Review requested: ${input.requestedAt}`,
    '',
    'Use the review-orchestrator skill to produce a structured walkthrough and inline draft comments via the `octomux review` CLI. Do NOT post to GitHub directly.',
  ].join('\n');
}

export interface ManualReviewPromptInput {
  sourceId: string;
  sourceTitle: string;
  repoShort: string;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string;
  prHeadSha: string;
  requestedAt: string;
}

/** Prompt used when the source task has no PR yet — manual pre-PR review. */
export function buildManualReviewPrompt(input: ManualReviewPromptInput): string {
  return [
    `/review-orchestrator`,
    '',
    `Task: ${input.sourceTitle} (id ${input.sourceId})`,
    `Repo: ${input.repoShort}`,
    `Branch: ${input.branch ?? ''}`,
    `Base: ${input.baseBranch ?? ''} @ ${input.baseSha}`,
    `Head: ${input.prHeadSha}`,
    `Review requested: ${input.requestedAt}`,
    '',
    'This is a manual pre-PR review. Use the review-orchestrator skill to produce a walkthrough and inline draft comments via the `octomux review` CLI. Do NOT post to GitHub directly.',
  ].join('\n');
}

export interface InsertReviewTaskParams {
  repoPath: string;
  branch: string;
  baseBranch: string;
  baseSha?: string | null;
  title: string;
  description: string;
  initialPrompt: string;
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string;
  /** When set, links the new review task back to its originating source task. */
  reviewOfTaskId?: string | null;
}

/**
 * Shared review-task creation: materialises a worktree row and a task row in
 * the `auto_review` source class. Returns the new task id. Used by both the
 * GitHub-poller path (PR-only) and the manual `/review` endpoint.
 */
export function insertReviewTask(params: InsertReviewTaskParams): string {
  const db = getDb();
  const id = nanoid(12);
  const worktreeId = nanoid(12);

  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES (?, '', ?, ?, ?, ?, 'new', 'available')`,
  ).run(worktreeId, params.repoPath, params.branch, params.baseBranch, params.baseSha ?? null);

  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, pr_url, pr_number, pr_head_sha,
        initial_prompt, source, worktree_id, review_of_task_id)
     VALUES (?, ?, ?, 'idle', 'backlog', ?, ?, ?, ?, 'auto_review', ?, ?)`,
  ).run(
    id,
    params.title,
    params.description,
    params.prUrl,
    params.prNumber,
    params.prHeadSha,
    params.initialPrompt,
    worktreeId,
    params.reviewOfTaskId ?? null,
  );

  return id;
}
