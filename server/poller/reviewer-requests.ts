import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { broadcast } from '../events.js';
import { readGithubLogin } from '../github-login.js';
import { childLogger } from '../logger.js';
import { buildPrReviewPrompt } from '../review-tasks.js';
import { getWorkflow } from '../workflows/registry.js';
import { sendMessageToAgent } from '../tmux-input.js';
import {
  getTask,
  listTaskRepoPaths,
  findExistingPrTask,
  hasTrashedPrReviewTask,
  listAutoReviewDrafts,
  listIdleAutoReviewTasksWithPr,
  hardDeleteTask,
  updateTaskPromptAndSha,
  setPrHeadSha,
  setPrReviewRequestedAt,
} from '../repositories/tasks.js';
import { deleteWorktree } from '../repositories/worktrees.js';
import { countAgentsForTask, findFirstActiveAgent } from '../repositories/workers.js';
import { resumeTask, softDeleteTask } from '../task-engine/index.js';
import { checkoutRef, fetchOriginQuiet } from '../task-engine/git.js';
import { sessionFor } from '../compute/index.js';
import { repoNameWithOwner } from './github-repo.js';
import type { Task } from '../types.js';

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
  /** REVIEW_REQUESTED_EVENT timeline entries — powers re-review on re-request. */
  reviewRequestEvents: Array<{ login: string; createdAt: string }>;
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
  timelineItems?: {
    nodes: Array<{
      createdAt?: string;
      requestedReviewer?: { login?: string } | null;
    } | null>;
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
        timelineItems(last: 50, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes {
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { ... on User { login } }
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
        reviewRequestEvents: (node.timelineItems?.nodes ?? [])
          .map((ev) => ({
            login: ev?.requestedReviewer?.login,
            createdAt: ev?.createdAt,
          }))
          .filter(
            (ev): ev is { login: string; createdAt: string } =>
              typeof ev.login === 'string' && typeof ev.createdAt === 'string',
          ),
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

/**
 * Latest review-request timestamp for the owner (ISO strings compare
 * lexicographically). Direct user requests only — team re-requests carry no
 * `login` and are dropped, matching isOwnerStillRequested's scope.
 */
function latestReviewRequestAt(pr: OpenReviewPR, ownerLogin: string): string | null {
  let latest: string | null = null;
  for (const ev of pr.reviewRequestEvents) {
    if (ev.login.toLowerCase() !== ownerLogin.toLowerCase()) continue;
    if (!latest || ev.createdAt > latest) latest = ev.createdAt;
  }
  return latest;
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

function buildReReviewNudge(pr: OpenReviewPR, taskId: string, headChanged: boolean): string {
  const reason = headChanged
    ? `Head advanced to ${pr.headRefOid}.`
    : `Head unchanged at ${pr.headRefOid} — review was explicitly re-requested, so run the ` +
      `re-review anyway (re-verify the open findings; discussion may have moved without a push).`;
  return (
    `Re-review requested for PR #${pr.number} (${pr.url}). ` +
    `${reason} ` +
    `Run the /review-artifact re-review flow — redeploy to the same artifact URL with a delta ` +
    `section, send the Slack ping as before, then close this task again with ` +
    `\`octomux close-task ${taskId}\`.`
  );
}

async function nudgeAgentForReReview(
  task: Task,
  tmuxSession: string,
  pr: OpenReviewPR,
  headChanged: boolean,
): Promise<boolean> {
  const agent = findFirstActiveAgent(task.id);
  if (!agent) return false;
  try {
    const compute = await sessionFor(task);
    await sendMessageToAgent(
      compute,
      tmuxSession,
      agent.window_index,
      buildReReviewNudge(pr, task.id, headChanged),
    );
    return true;
  } catch (err) {
    logger.warn(
      { task_id: task.id, err: (err as Error).message },
      'failed to nudge agent for re-review (session may be gone)',
    );
    return false;
  }
}

async function checkoutNewHead(task: Task, worktreePath: string | null, headRefOid: string) {
  if (!worktreePath) return;
  try {
    const compute = await sessionFor(task);
    await fetchOriginQuiet(compute, worktreePath);
    await checkoutRef(compute, worktreePath, headRefOid);
  } catch (err) {
    logger.warn(
      { task_id: task.id, err: (err as Error).message },
      'failed to fetch/checkout new head; proceeding — the agent can fetch for itself',
    );
  }
}

async function upsertReviewTask(
  repoPath: string,
  pr: OpenReviewPR,
  ownerLogin: string,
): Promise<{ action: 'created' | 'updated' | 'nudged' | 'resumed' | 'skipped'; taskId?: string }> {
  const existing = findExistingPrTask(repoPath, pr.number);
  const requestedAt = latestReviewRequestAt(pr, ownerLogin);

  if (existing) {
    if (existing.source !== 'auto_review') return { action: 'skipped' };

    const headChanged = existing.pr_head_sha !== pr.headRefOid;
    // A review-request event newer than the one we last acted on = the author
    // re-requested review without pushing. Rows from before this column existed
    // (NULL baseline) can't distinguish old from new requests — backfill the
    // baseline and only trigger on the next event.
    const reRequested =
      requestedAt !== null &&
      existing.pr_review_requested_at !== null &&
      requestedAt > existing.pr_review_requested_at;
    if (!headChanged && !reRequested) {
      if (requestedAt && !existing.pr_review_requested_at) {
        setPrReviewRequestedAt(existing.id, requestedAt);
      }
      return { action: 'skipped' };
    }

    // Written only after the trigger actually lands — a failed nudge/resume
    // must leave the baseline behind so the next poll cycle retries.
    const markTriggered = () => {
      setPrHeadSha(existing.id, pr.headRefOid);
      if (requestedAt) setPrReviewRequestedAt(existing.id, requestedAt);
    };

    if (existing.runtime_state === 'idle') {
      if (countAgentsForTask(existing.id) > 0) {
        // Closed-but-resumable review session: resume the same conversation
        // (harness session id) and hand it the re-review prompt.
        const task = getTask(existing.id) as Task | undefined;
        if (!task) return { action: 'skipped' };
        if (headChanged) await checkoutNewHead(task, existing.worktree_path, pr.headRefOid);
        await resumeTask(task, { prompt: buildReReviewNudge(pr, existing.id, headChanged) });
        markTriggered();
        setPrHeadSha(existing.id, pr.headRefOid);
        return { action: 'resumed', taskId: existing.id };
      }

      // Never-started draft: refresh the prompt + sha; startTask delivers it.
      // A bare re-request needs no prompt churn — the draft hasn't run yet.
      if (headChanged) {
        const updatedPrompt = buildShaUpdateNote(
          existing.initial_prompt ?? buildReviewPrompt(pr, new Date().toISOString(), existing.id),
          pr.headRefOid,
          new Date().toISOString(),
        );
        updateTaskPromptAndSha(existing.id, pr.headRefOid, updatedPrompt);
      }
      if (requestedAt) setPrReviewRequestedAt(existing.id, requestedAt);
      return headChanged ? { action: 'updated', taskId: existing.id } : { action: 'skipped' };
    }

    if (existing.runtime_state === 'running' || existing.runtime_state === 'setting_up') {
      if (!existing.tmux_session) return { action: 'skipped' };

      const task = getTask(existing.id) as Task | undefined;
      if (!task) return { action: 'skipped' };
      if (headChanged) await checkoutNewHead(task, existing.worktree_path, pr.headRefOid);
      const delivered = await nudgeAgentForReReview(
        task,
        existing.tmux_session,
        pr,
        headChanged,
      );
      if (!delivered) return { action: 'skipped' };
      markTriggered();
      return { action: 'nudged', taskId: existing.id };
    }

    return { action: 'skipped' };
  }

  // The user deleted this PR's review — don't resurrect it while the trashed
  // task exists (its worktree is only removed when the trash purges, so an
  // early recreate would error on the leftover worktree anyway).
  if (hasTrashedPrReviewTask(repoPath, pr.number)) {
    return { action: 'skipped' };
  }

  await getWorkflow('reviewer')!.run!({
    repoPath,
    config: {},
    event: {
      pr_number: pr.number,
      pr_url: pr.url,
      pr_head_sha: pr.headRefOid,
      base_branch: pr.baseRefName,
      title: pr.title,
      author: pr.author?.login ?? null,
      requested_at: new Date().toISOString(),
    },
  });
  const created = findExistingPrTask(repoPath, pr.number);
  if (!created || created.source !== 'auto_review') {
    return { action: 'skipped' };
  }
  // Baseline for re-request detection on later cycles.
  if (requestedAt) setPrReviewRequestedAt(created.id, requestedAt);
  return { action: 'created', taskId: created.id };
}

/**
 * Fetch the state (OPEN/MERGED/CLOSED) of a set of PR numbers in one aliased
 * GraphQL call. Returns an empty map on total failure (skip cleanup this
 * cycle); a PR that resolves to null (deleted repo/PR) is reported as CLOSED.
 */
async function fetchPrStates(nwo: string, numbers: number[]): Promise<Map<number, string>> {
  const states = new Map<number, string>();
  const [owner, name] = nwo.split('/');
  if (!owner || !name || numbers.length === 0) return states;

  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { state }`).join(' ');
  const query = `query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`;

  let stdout = '';
  try {
    ({ stdout } = await execFile('gh', ['api', 'graphql', '-f', `query=${query}`]));
  } catch (err) {
    // gh exits non-zero when the response carries a GraphQL errors array
    // (e.g. one missing PR) but still prints the partial-data body.
    stdout = (err as { stdout?: string }).stdout ?? '';
    if (!stdout) {
      logger.debug({ nwo, err: (err as Error).message }, 'gh PR state query failed');
      return states;
    }
  }

  try {
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      data?: { repository?: Record<string, { state?: string } | null> | null };
    };
    const repo = parsed.data?.repository;
    if (!repo) return states;
    for (const n of numbers) {
      states.set(n, repo[`p${n}`]?.state ?? 'CLOSED');
    }
  } catch {
    logger.debug({ nwo }, 'gh PR state query returned unparseable output');
  }
  return states;
}

/**
 * Two-stage cleanup so reviews never dangle:
 * 1. Never-started drafts whose PR left the review-requested set — purge
 *    immediately (no session worth preserving, no API call needed).
 * 2. Closed-but-resumable sessions — kept while their PR is open (re-review /
 *    follow-up chat), trashed once the PR is merged or closed.
 */
async function cleanupResolvedReviews(
  repoPath: string,
  nwo: string,
  activePrNumbers: Set<number>,
): Promise<string[]> {
  const deletedIds: string[] = [];

  for (const draft of listAutoReviewDrafts(repoPath)) {
    if (draft.pr_number === null) continue;
    if (activePrNumbers.has(draft.pr_number)) continue;
    hardDeleteTask(draft.id);
    if (draft.worktree_id) {
      deleteWorktree(draft.worktree_id);
    }
    deletedIds.push(draft.id);
  }

  // Active PRs are open by definition (the search is `is:pr is:open`).
  const candidates = listIdleAutoReviewTasksWithPr(repoPath).filter(
    (t) => !activePrNumbers.has(t.pr_number),
  );
  if (candidates.length === 0) return deletedIds;

  const states = await fetchPrStates(nwo, [...new Set(candidates.map((t) => t.pr_number))]);
  for (const candidate of candidates) {
    const state = states.get(candidate.pr_number);
    if (state !== 'MERGED' && state !== 'CLOSED') continue;
    const task = getTask(candidate.id) as Task | undefined;
    if (!task) continue;
    await softDeleteTask(task);
    logger.info(
      { task_id: candidate.id, pr_number: candidate.pr_number, pr_state: state },
      'trashed review session for merged/closed PR',
    );
    deletedIds.push(candidate.id);
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

      const result = await upsertReviewTask(repoPath, pr, ownerLogin);
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
      } else if (result.action === 'resumed') {
        logger.info(
          {
            task_id: result.taskId,
            pr_number: pr.number,
            repo_path: repoPath,
            head: pr.headRefOid,
          },
          'resumed closed review session for PR re-review',
        );
        broadcast({ type: 'task:updated', payload: { taskId: result.taskId! } });
      }
    }

    const deletedIds = await cleanupResolvedReviews(repoPath, nwo, activePrNumbers);
    for (const taskId of deletedIds) {
      logger.info({ task_id: taskId, repo_path: repoPath }, 'removed resolved auto-review task');
      broadcast({ type: 'task:deleted', payload: { taskId } });
    }
  }
}
