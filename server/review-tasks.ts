import path from 'path';
import { nanoid } from 'nanoid';
import { insertTask, insertWorktree } from './repositories/index.js';
import { octomuxSkillRef } from './octomux-plugin.js';

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
  /** Id of THIS review task — the id every `octomux review` command must target. */
  reviewTaskId: string;
  title: string;
  number: number;
  url: string;
  author?: string | null;
  headRefOid: string;
  requestedAt: string;
}

/**
 * Instruction line shared by both prompt shapes, pinning the exact id the
 * orchestrator must pass to the review CLI. Without this the agent has to guess
 * its own task id (or, worse, latches onto a source id printed elsewhere in the
 * prompt) and writes the run/comments under the wrong task_id.
 */
function reviewTaskIdLines(reviewTaskId: string): string[] {
  return [
    `Review task id: ${reviewTaskId}`,
    `Pass this exact id to every \`octomux review\` command, e.g. \`--task ${reviewTaskId}\`.`,
  ];
}

/**
 * Slack ping instruction appended to review prompts. Opt-in: set
 * OCTOMUX_REVIEW_SLACK_CHANNEL on the server to enable. The agent-side
 * `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` is inherited from the octomux-owned tmux
 * server environment, so no per-agent env plumbing is needed.
 */
function reviewSlackPingLines(): string[] {
  const channel = process.env.OCTOMUX_REVIEW_SLACK_CHANNEL;
  if (!channel) return [];
  return [
    '',
    `After deploying the artifact, ping Slack channel ${channel} with ONE message: verdict tier,` +
      ' PR link, artifact URL, and each critical/issue finding on its own line:',
    '```',
    'curl -s -X POST https://slack.com/api/chat.postMessage' +
      ' -H "Authorization: Bearer $OCTOMUX_GATEWAY_SLACK_BOT_TOKEN"' +
      ` -d "channel=${channel}" --data-urlencode "text=<message>"`,
    '```',
  ];
}

/** Prompt used when the source has an open PR — same shape the poller emits. */
export function buildPrReviewPrompt(input: PrReviewPromptInput): string {
  const author = input.author ?? 'unknown';
  return [
    `Review task id: ${input.reviewTaskId}`,
    '',
    `PR: ${input.title} (#${input.number}) by @${author}`,
    `URL: ${input.url}`,
    `Head: ${input.headRefOid}`,
    `Review requested: ${input.requestedAt}`,
    '',
    `Check out the PR head in this worktree first (\`gh pr checkout ${input.number}\`), then run` +
      ' the review-artifact skill (/review-artifact) on this PR. This octomux task intentionally' +
      ' uses the artifact flow — ignore the skill\'s "not for octomux review tasks" caveat.' +
      ' The artifact report is the deliverable; do NOT draft or post GitHub comments.',
    ...reviewSlackPingLines(),
    '',
    `When the review is delivered, close this task with \`octomux close-task ${input.reviewTaskId}\`` +
      ' — the closed session stays resumable for re-review rounds and follow-up questions.',
  ].join('\n');
}

export interface ManualReviewPromptInput {
  /** Id of THIS review task — the id every `octomux review` command must target. */
  reviewTaskId: string;
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
    octomuxSkillRef('review-walkthrough'),
    '',
    ...reviewTaskIdLines(input.reviewTaskId),
    '',
    `Source task (context only — do NOT pass to --task): ${input.sourceTitle} (id ${input.sourceId})`,
    `Repo: ${input.repoShort}`,
    `Branch: ${input.branch ?? ''}`,
    `Base: ${input.baseBranch ?? ''} @ ${input.baseSha}`,
    `Head: ${input.prHeadSha}`,
    `Review requested: ${input.requestedAt}`,
    '',
    'This is a manual pre-PR review. Use the review-walkthrough skill to produce the structured' +
      ' walkthrough via the `octomux review` CLI. Do NOT draft comments or post to GitHub.',
  ].join('\n');
}

export interface DeepReviewPromptInput {
  /** Id of THIS review task — the id every `octomux review` command must target. */
  reviewTaskId: string;
}

/** Prompt for the auto-chained deep-review agent (phase 2). */
export function buildDeepReviewPrompt(input: DeepReviewPromptInput): string {
  return [
    octomuxSkillRef('review-deep'),
    '',
    ...reviewTaskIdLines(input.reviewTaskId),
    '',
    'The walkthrough is already ingested. Run `octomux review start` to load it ' +
      '(plus playbook, learnings, previous review), then run the deep-review engine, ' +
      'draft inline comments, and complete. Do NOT post to GitHub directly.',
  ].join('\n');
}

export interface InsertReviewTaskParams {
  /**
   * Pre-generated id for the review task. Callers that embed the id in the
   * orchestrator prompt MUST pass it here so the prompt and the DB row agree.
   * Falls back to a fresh nanoid when omitted.
   */
  id?: string;
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
  const id = params.id ?? nanoid(12);
  const worktreeId = nanoid(12);

  insertWorktree({
    id: worktreeId,
    path: '',
    repo_path: params.repoPath,
    branch: params.branch,
    base_branch: params.baseBranch,
    base_sha: params.baseSha ?? null,
    mode: 'new',
    status: 'available',
  });

  insertTask({
    id,
    title: params.title,
    description: params.description,
    runtime_state: 'idle',
    workflow_status: 'backlog',
    pr_url: params.prUrl,
    pr_number: params.prNumber,
    pr_head_sha: params.prHeadSha,
    initial_prompt: params.initialPrompt,
    source: 'auto_review',
    worktree_id: worktreeId,
    review_of_task_id: params.reviewOfTaskId ?? null,
  });

  return id;
}
