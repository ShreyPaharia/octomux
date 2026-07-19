/**
 * Service layer for review-task orchestration.
 * HTTP-agnostic: depends only on repos, review-tasks helpers, task-runner,
 * and broadcast. Never imports express or touches req/res.
 *
 * De-dup boundary: callers own ALL pre-create work (GitHub/git-remote
 * resolution, repo resolution, existing-review dedup). These functions are the
 * create/trigger TAIL only — they assume the caller has already decided to act.
 */

import { nanoid } from 'nanoid';
import {
  buildPrReviewPrompt,
  buildManualReviewPrompt,
  insertReviewTask,
  repoShortName,
} from '../review-tasks.js';
import { getTask, insertRun } from '../repositories/index.js';
import { startTask } from '../task-engine/index.js';
import { sendMessageToAgent } from '../tmux-input.js';
import { findFirstActiveAgent } from '../repositories/agent-runtime.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { Task } from '../types.js';

const logger = childLogger('review-service');

// ─── createReviewTaskFromPr ─────────────────────────────────────────────────

export interface CreateReviewFromPrInput {
  /** Local repo path the review worktree is rooted at. */
  repo_path: string;
  /** PR number. */
  pr_number: number;
  /** PR url. */
  pr_url: string;
  /** PR head sha to diff against. */
  pr_head_sha: string;
  /** PR base ref name. */
  base_branch: string;
  /** PR title (used for the prompt + task title). */
  title: string;
  /** PR author login (nullable). */
  author: string | null;
  /** ISO timestamp the review was requested. */
  requested_at: string;
}

export interface CreateReviewResult {
  id: string;
  task: Task;
}

/**
 * Create-tail for a PR-backed review task. Mints the id, builds the PR review
 * prompt, inserts the review task, reads it back, broadcasts task:created, and
 * fire-and-forget kicks startTask (broadcasting task:updated on settle).
 *
 * The caller MUST have already resolved the PR/repo and run its dedup query.
 */
export async function createReviewTaskFromPr(
  input: CreateReviewFromPrInput,
): Promise<CreateReviewResult> {
  const id = nanoid(12);
  const short = repoShortName(input.repo_path);
  const branch = `review/${short}-pr-${input.pr_number}`;

  const initialPrompt = buildPrReviewPrompt({
    reviewTaskId: id,
    title: input.title,
    number: input.pr_number,
    url: input.pr_url,
    author: input.author,
    headRefOid: input.pr_head_sha,
    requestedAt: input.requested_at,
  });

  insertReviewTask({
    id,
    repoPath: input.repo_path,
    branch,
    baseBranch: input.base_branch,
    title: `Review: ${input.title} (#${input.pr_number})`,
    description: `Review task for PR #${input.pr_number}`,
    initialPrompt,
    prUrl: input.pr_url,
    prNumber: input.pr_number,
    prHeadSha: input.pr_head_sha,
  });

  insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: id });

  const task = readbackAndKick(id);
  return { id, task };
}

// ─── createManualReview ─────────────────────────────────────────────────────

export interface CreateManualReviewInput {
  /** The source task being reviewed. */
  source_task_id: string;
  source_title: string;
  repo_path: string;
  branch: string | null;
  base_branch: string | null;
  base_sha: string | null;
  /** Resolved head sha (caller resolves HEAD when the task has no PR). */
  pr_head_sha: string;
  /** Set when the source has an open PR. */
  pr_url: string | null;
  pr_number: number | null;
  requested_at: string;
}

/**
 * Create-tail for a manually-triggered review pointing back at a source task.
 * Builds the PR or pre-PR prompt depending on whether the source has a PR,
 * inserts the review task (linked via review_of_task_id), reads it back,
 * broadcasts task:created, and fire-and-forget kicks startTask.
 *
 * The caller MUST have already validated the source task + run its dedup query.
 */
export async function createManualReview(
  input: CreateManualReviewInput,
): Promise<CreateReviewResult> {
  const short = repoShortName(input.repo_path || '');
  const id = nanoid(12);

  let branch: string;
  let title: string;
  let description: string;
  let prompt: string;
  if (input.pr_url && input.pr_number != null) {
    branch = `review/${short}-pr-${input.pr_number}`;
    title = `Review: ${input.source_title} (#${input.pr_number})`;
    description = `Manual review for PR #${input.pr_number} in ${short}`;
    prompt = buildPrReviewPrompt({
      reviewTaskId: id,
      title: input.source_title,
      number: input.pr_number,
      url: input.pr_url,
      author: null,
      headRefOid: input.pr_head_sha,
      requestedAt: input.requested_at,
    });
  } else {
    branch = `review/${short}-task-${input.source_task_id}`;
    title = `Review: ${input.source_title}`;
    description = `Manual pre-PR review for task ${input.source_task_id}`;
    prompt = buildManualReviewPrompt({
      reviewTaskId: id,
      sourceId: input.source_task_id,
      sourceTitle: input.source_title,
      repoShort: short,
      branch: input.branch,
      baseBranch: input.base_branch,
      baseSha: input.base_sha ?? '',
      prHeadSha: input.pr_head_sha,
      requestedAt: input.requested_at,
    });
  }

  const newId = insertReviewTask({
    id,
    repoPath: input.repo_path,
    branch,
    baseBranch: input.base_branch ?? '',
    baseSha: input.base_sha ?? null,
    title,
    description,
    initialPrompt: prompt,
    prUrl: input.pr_url ?? null,
    prNumber: input.pr_number ?? null,
    prHeadSha: input.pr_head_sha,
    reviewOfTaskId: input.source_task_id,
  });

  const task = readbackAndKick(newId);

  logger.info(
    { task_id: newId, source_task_id: input.source_task_id, pr_number: input.pr_number ?? null },
    'manual review task created',
  );

  return { id: newId, task };
}

// ─── triggerReviewRun ───────────────────────────────────────────────────────

/**
 * Trigger a manual re-review of an existing review task: if the task is not
 * running, (re)start it; otherwise nudge the first active agent.
 *
 * HTTP validation (404 / 409-already-running) stays in the handler.
 */
export async function triggerReviewRun(task: Task): Promise<void> {
  if (task.runtime_state !== 'running') {
    await startTask(task);
    return;
  }

  const agent = findFirstActiveAgent(task.id);
  if (agent && task.tmux_session) {
    await sendMessageToAgent(task.tmux_session, agent.window_index, manualReRunNudge());
  }
}

/** Message sent to a running agent to trigger a manual re-review. */
export function manualReRunNudge(): string {
  return 'Re-review requested manually. Please re-run the /review-pr flow on the current PR.';
}

// ─── shared create tail ─────────────────────────────────────────────────────

/**
 * Read back the freshly-inserted review task, broadcast task:created, and
 * fire-and-forget kick startTask (broadcasting task:updated when it settles).
 */
function readbackAndKick(id: string): Task {
  broadcast({ type: 'task:created', payload: { taskId: id } });

  const fresh = getTask(id) as Task;
  fresh.agents = [];
  fresh.user_terminals = [];

  // Fire-and-forget: the response shouldn't block on worktree setup.
  startTask(fresh)
    .then(() => broadcast({ type: 'task:updated', payload: { taskId: id } }))
    .catch((err) => {
      logger.error(
        { task_id: id, err: (err as Error).message },
        'failed to auto-start review task',
      );
      broadcast({ type: 'task:updated', payload: { taskId: id } });
    });

  return fresh;
}
