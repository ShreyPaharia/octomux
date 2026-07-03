import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { broadcast } from '../events.js';
import { readGithubLogin } from '../github-login.js';
import { childLogger } from '../logger.js';
import { buildPrReviewPrompt } from '../review-tasks.js';
import { createReviewTaskFromPr } from '../services/review-service.js';
import { sendMessageToAgent } from '../tmux-input.js';
import {
  listTaskRepoPaths,
  findExistingPrTask,
  listAutoReviewDrafts,
  hardDeleteTask,
  updateTaskPromptAndSha,
  setPrHeadSha,
} from '../repositories/tasks.js';
import { deleteWorktree } from '../repositories/worktrees.js';
import { findFirstActiveAgent } from '../repositories/agent-runtime.js';
import { repoNameWithOwner } from './github-repo.js';

const logger = childLogger('poller');
const execFile = promisify(execFileCb);

interface ReviewRequestEntity {
  login?: string;
}

interface OpenReviewPR {
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  reviewRequests: ReviewRequestEntity[];
}

function listTrackedRepos(): string[] {
  const rows = listTaskRepoPaths();
  return rows.map((r) => r.repo_path);
}

interface RawSearchNode {
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  repository: { nameWithOwner: string };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { __typename?: string; login?: string } | null;
    }>;
  };
}

const REVIEW_REQUESTED_GRAPHQL_QUERY = `query {
  search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        author { login }
        headRefOid
        headRefName
        baseRefName
        repository { nameWithOwner }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
            }
          }
        }
      }
    }
  }
}`;

async function fetchAllReviewRequestedPRs(): Promise<Map<string, OpenReviewPR[]>> {
  const byRepo = new Map<string, OpenReviewPR[]>();
  try {
    const { stdout } = await execFile('gh', [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_REQUESTED_GRAPHQL_QUERY}`,
    ]);
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      data?: { search?: { nodes?: RawSearchNode[] } };
    };
    const nodes = parsed.data?.search?.nodes ?? [];
    for (const node of nodes) {
      if (!node || !node.repository?.nameWithOwner) continue;
      const pr: OpenReviewPR = {
        number: node.number,
        title: node.title,
        url: node.url,
        author: node.author,
        headRefOid: node.headRefOid,
        headRefName: node.headRefName,
        baseRefName: node.baseRefName,
        reviewRequests: (node.reviewRequests?.nodes ?? [])
          .map((rr) => ({ login: rr.requestedReviewer?.login }))
          .filter((rr): rr is { login: string } => typeof rr.login === 'string'),
      };
      const key = node.repository.nameWithOwner.toLowerCase();
      const list = byRepo.get(key);
      if (list) list.push(pr);
      else byRepo.set(key, [pr]);
    }
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn('gh rate limit hit on graphql search — backing off until next cycle');
    } else {
      logger.debug({ err: msg }, 'gh api graphql search failed');
    }
  }
  return byRepo;
}

function isOwnerStillRequested(pr: OpenReviewPR, ownerLogin: string): boolean {
  return pr.reviewRequests.some(
    (rr) => typeof rr.login === 'string' && rr.login.toLowerCase() === ownerLogin.toLowerCase(),
  );
}

function buildReviewPrompt(pr: OpenReviewPR, requestedAt: string, reviewTaskId: string): string {
  return buildPrReviewPrompt({
    reviewTaskId,
    title: pr.title,
    number: pr.number,
    url: pr.url,
    author: pr.author?.login,
    headRefOid: pr.headRefOid,
    requestedAt,
  });
}

function buildShaUpdateNote(prompt: string, newSha: string, timestamp: string): string {
  return `${prompt}\n\nUpdated: head advanced to ${newSha} at ${timestamp}`;
}

function buildReReviewNudge(pr: OpenReviewPR, previousHeadReachable = true): string {
  return (
    `Re-review requested for PR #${pr.number}. ` +
    `Head advanced to ${pr.headRefOid}. ` +
    `previous_head_unreachable=${!previousHeadReachable}. ` +
    `Please pull the latest and re-run the /review-pr flow on ${pr.url}.`
  );
}

async function nudgeAgentForReReview(
  taskId: string,
  tmuxSession: string,
  pr: OpenReviewPR,
  previousHeadReachable = true,
): Promise<boolean> {
  const agent = findFirstActiveAgent(taskId);
  if (!agent) return false;
  try {
    const message = buildReReviewNudge(pr, previousHeadReachable);
    await sendMessageToAgent(tmuxSession, agent.window_index, message);
    return true;
  } catch (err) {
    logger.warn(
      { task_id: taskId, err: (err as Error).message },
      'failed to nudge agent for re-review (session may be gone)',
    );
    return false;
  }
}

async function upsertReviewTask(
  repoPath: string,
  pr: OpenReviewPR,
): Promise<{ action: 'created' | 'updated' | 'nudged' | 'skipped'; taskId?: string }> {
  const existing = findExistingPrTask(repoPath, pr.number);

  if (existing) {
    if (existing.source !== 'auto_review') return { action: 'skipped' };
    if (existing.pr_head_sha === pr.headRefOid) return { action: 'skipped' };

    if (existing.runtime_state === 'idle') {
      const updatedPrompt = buildShaUpdateNote(
        existing.initial_prompt ?? buildReviewPrompt(pr, new Date().toISOString(), existing.id),
        pr.headRefOid,
        new Date().toISOString(),
      );
      updateTaskPromptAndSha(existing.id, pr.headRefOid, updatedPrompt);
      return { action: 'updated', taskId: existing.id };
    }

    if (existing.runtime_state === 'running' || existing.runtime_state === 'setting_up') {
      if (!existing.tmux_session) return { action: 'skipped' };

      let previousHeadReachable = true;
      if (existing.worktree_path) {
        try {
          await execFile('git', ['-C', existing.worktree_path, 'fetch', 'origin', '--quiet']);
          await execFile('git', ['-C', existing.worktree_path, 'checkout', pr.headRefOid]);
        } catch (err) {
          logger.warn(
            { task_id: existing.id, err: (err as Error).message },
            'failed to fetch/checkout new head; nudging anyway and letting agent retry',
          );
        }
        if (existing.pr_head_sha) {
          try {
            await execFile('git', [
              '-C',
              existing.worktree_path,
              'merge-base',
              '--is-ancestor',
              existing.pr_head_sha,
              pr.headRefOid,
            ]);
          } catch {
            previousHeadReachable = false;
          }
        }
      }

      const delivered = await nudgeAgentForReReview(
        existing.id,
        existing.tmux_session,
        pr,
        previousHeadReachable,
      );
      if (!delivered) return { action: 'skipped' };
      setPrHeadSha(existing.id, pr.headRefOid);
      return { action: 'nudged', taskId: existing.id };
    }

    return { action: 'skipped' };
  }

  const { id } = await createReviewTaskFromPr({
    repo_path: repoPath,
    pr_number: pr.number,
    pr_url: pr.url,
    pr_head_sha: pr.headRefOid,
    base_branch: pr.baseRefName,
    title: pr.title,
    author: pr.author?.login ?? null,
    requested_at: new Date().toISOString(),
  });
  return { action: 'created', taskId: id };
}

function cleanupResolvedReviewDrafts(repoPath: string, activePrNumbers: Set<number>): string[] {
  const drafts = listAutoReviewDrafts(repoPath);
  const deletedIds: string[] = [];
  for (const draft of drafts) {
    if (draft.pr_number === null) continue;
    if (activePrNumbers.has(draft.pr_number)) continue;
    hardDeleteTask(draft.id);
    if (draft.worktree_id) {
      deleteWorktree(draft.worktree_id);
    }
    deletedIds.push(draft.id);
  }
  return deletedIds;
}

export async function pollReviewerRequests(): Promise<void> {
  const ownerLogin = readGithubLogin();
  if (!ownerLogin) return;

  const repos = listTrackedRepos();
  if (repos.length === 0) return;

  const tracked: Array<{ repoPath: string; nwo: string }> = [];
  for (const repoPath of repos) {
    const nwo = await repoNameWithOwner(repoPath);
    if (nwo) tracked.push({ repoPath, nwo: nwo.toLowerCase() });
  }
  if (tracked.length === 0) return;

  const prsByNwo = await fetchAllReviewRequestedPRs();

  for (const { repoPath, nwo } of tracked) {
    const prs = prsByNwo.get(nwo) ?? [];
    const activePrNumbers = new Set<number>();

    for (const pr of prs) {
      if (!isOwnerStillRequested(pr, ownerLogin)) continue;
      activePrNumbers.add(pr.number);

      const result = await upsertReviewTask(repoPath, pr);
      if (result.action === 'created') {
        logger.info(
          { task_id: result.taskId, pr_number: pr.number, repo_path: repoPath },
          'auto-created review task for reviewer request',
        );
      } else if (result.action === 'updated') {
        logger.info(
          {
            task_id: result.taskId,
            pr_number: pr.number,
            repo_path: repoPath,
            head: pr.headRefOid,
          },
          'updated auto-review task for new PR head',
        );
        broadcast({ type: 'task:updated', payload: { taskId: result.taskId! } });
      } else if (result.action === 'nudged') {
        logger.info(
          {
            task_id: result.taskId,
            pr_number: pr.number,
            repo_path: repoPath,
            head: pr.headRefOid,
          },
          'nudged running agent for PR re-review',
        );
        broadcast({ type: 'task:updated', payload: { taskId: result.taskId! } });
      }
    }

    const deletedIds = cleanupResolvedReviewDrafts(repoPath, activePrNumbers);
    for (const taskId of deletedIds) {
      logger.info({ task_id: taskId, repo_path: repoPath }, 'removed auto-review draft (resolved)');
      broadcast({ type: 'task:deleted', payload: { taskId } });
    }
  }
}
