import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { nanoid } from 'nanoid';
import { getSettings } from './settings.js';
import { closeTask, deleteTask, startTask, addAgent } from './task-runner.js';
import { installHookSettings } from './hook-settings.js';
import { broadcast } from './events.js';
import { childLogger } from './logger.js';
import { readGithubLogin } from './github-login.js';
import { fireHook } from './hook-dispatcher.js';
import { sendMessageToAgent } from './tmux-input.js';
import {
  buildDeepReviewPrompt,
  buildPrReviewPrompt,
  insertReviewTask,
  repoShortName,
} from './review-tasks.js';
import { execTmux } from './tmux-bin.js';
import type { Task, UserTerminal } from './types.js';
import {
  listRunningTasks,
  getTask,
  setRuntimeStateIdle,
  setRuntimeStateSetupInterrupted,
  setTaskPrDetected,
  updateTaskPromptAndSha,
  setPrHeadSha,
  setWorkflowStatusDone,
  addTaskUpdate,
  listTasksNeedingPrDetection,
  listRunningTasksWithPr,
  findExistingPrTask,
  listAutoReviewDrafts,
  hardDeleteTask,
  listExpiredSoftDeletes,
  listWalkthroughHandoffTasks,
  listActiveTasksForHooks,
  listTaskRepoPaths,
  getParentTaskTmuxSession,
} from './repositories/tasks.js';
import { deleteWorktree } from './repositories/worktrees.js';
import {
  stopRunningAgentsForTask,
  findFirstActiveAgent,
  listWatchedAgents,
  getNotifyAgentTarget,
  stopAgent,
  getTaskHookToken,
  listRunningTerminals,
  updateUserTerminalStatus,
} from './repositories/agent-runtime.js';
import { completeTeamRunByLeadTask } from './repositories/team-schedules.js';
import {
  findStuckReviewRuns,
  failReviewRunById,
  claimDeepReviewAttach,
} from './repositories/review-runs.js';

const logger = childLogger('poller');

const execFile = promisify(execFileCb);

const STATUS_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
const PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
const MERGED_PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
const DELETE_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60 * 60 * 1000; // 1h
const TEAM_SCHEDULE_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000; // check every minute
const HANDOFF_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
// Sweep expired orchestrator approval cards once a minute (SHR-164).
const APPROVAL_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;

let statusTimer: ReturnType<typeof setInterval> | null = null;
let prTimer: ReturnType<typeof setInterval> | null = null;
let mergedPrTimer: ReturnType<typeof setInterval> | null = null;
let deleteTimer: ReturnType<typeof setInterval> | null = null;
let teamScheduleTimer: ReturnType<typeof setInterval> | null = null;
let handoffTimer: ReturnType<typeof setInterval> | null = null;
let approvalTimer: ReturnType<typeof setInterval> | null = null;

// ─── Session Status Polling ──────────────────────────────────────────────────

async function notifyParentTask(parentTaskId: string, finishedTask: Task): Promise<void> {
  const parent = getParentTaskTmuxSession(parentTaskId);
  if (!parent?.tmux_session) return;

  const agent = findFirstActiveAgent(parentTaskId);
  if (!agent) return;

  const msg = `[octomux] Worker task ${finishedTask.id} ("${finishedTask.title}") finished. Check results: octomux get-task --json ${finishedTask.id}`;
  await sendMessageToAgent(parent.tmux_session, agent.window_index, msg);
}

export async function checkTaskStatus(task: Task): Promise<'alive' | 'dead'> {
  if (!task.tmux_session) return 'dead';
  try {
    await execTmux(['has-session', '-t', task.tmux_session]);
    return 'alive';
  } catch {
    return 'dead';
  }
}

export async function pollStatuses(): Promise<void> {
  // tmux_session IS NOT NULL: a task in 'setting_up' with no session yet is
  // still mid-createTask — skip it so we don't race the setup writing the
  // session column and mark the task 'Setup interrupted' prematurely.
  const runningTasks = listRunningTasks();

  const results = await Promise.allSettled(
    runningTasks.map(async (task) => {
      const status = await checkTaskStatus(task);
      return { task, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, status } = result.value;
    if (status !== 'dead') continue;

    const rs = task.runtime_state;
    if (rs === 'running') {
      setRuntimeStateIdle(task.id);
    } else if (rs === 'setting_up') {
      setRuntimeStateSetupInterrupted(task.id);
    } else {
      continue;
    }
    completeTeamRunByLeadTask(task.id);
    stopRunningAgentsForTask(task.id);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });

    if (task.notify_task_id) {
      notifyParentTask(task.notify_task_id, task).catch(() => {});
    }
  }

  await pollTerminalActivity();
  await pollAgentWindows();
}

// ─── Agent Window Polling ─────────────────────────────────────────────────────

async function checkWindowStatus(session: string, windowIndex: number): Promise<'alive' | 'dead'> {
  try {
    await execTmux(['display-message', '-t', `${session}:${windowIndex}`, '-p', '#I']);
    return 'alive';
  } catch {
    return 'dead';
  }
}

async function pollAgentWindows(): Promise<void> {
  const watchedAgents = listWatchedAgents();

  const results = await Promise.allSettled(
    watchedAgents.map(async (agent) => {
      const status = await checkWindowStatus(agent.tmux_session, agent.window_index);
      return { agent, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { agent, status } = result.value;
    if (status !== 'dead') continue;

    stopAgent(agent.id);

    const target = getNotifyAgentTarget(agent.notify_agent_id);

    if (!target) continue;

    const msg = `[octomux] Sub-agent ${agent.id} ("${agent.label}") finished. Check results: octomux get-task --json ${agent.task_id}`;
    await sendMessageToAgent(target.tmux_session, target.window_index, msg);
  }
}

// ─── Hook Installation ──────────────────────────────────────────────────────

/**
 * Ensure hooks are installed in all running task worktrees.
 * Handles tasks created before the hook feature existed.
 */
export async function ensureHooksInstalled(): Promise<void> {
  const runningTasks = listActiveTasksForHooks();

  for (const task of runningTasks) {
    try {
      // Worktree settings.local.json is shared across all agents in this task.
      // Pick any agent's hook_token (createTask + addAgent ensure they're all
      // equal). Skip the task if no agent has a token yet — the next agent's
      // creation will install hooks correctly.
      const row = getTaskHookToken(task.id);
      if (!row) continue;
      await installHookSettings(task.worktree!, task.harness_id, row.hook_token);
    } catch {
      // Non-critical — don't crash the poller
    }
  }
}

// ─── PR Detection ────────────────────────────────────────────────────────────

export async function detectPR(task: Task): Promise<{ url: string; number: number } | null> {
  if (!task.branch || !task.repo_path) return null;
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'list', '--head', task.branch, '--json', 'url,number', '--limit', '1'],
      {
        cwd: task.repo_path,
      },
    );
    const prs = JSON.parse(stdout.trim() || '[]');
    if (prs.length > 0) {
      return { url: prs[0].url, number: prs[0].number };
    }
    return null;
  } catch {
    return null;
  }
}

export async function pollPRs(): Promise<void> {
  const tasks = listTasksNeedingPrDetection();

  if (tasks.length === 0) return;

  // Resolve each task's repo to owner/repo so we can fetch all open-PR-by-branch
  // lookups in a single aliased GraphQL query instead of one `gh pr list` per task.
  const eligible: Array<{ task: Task; owner: string; name: string; branch: string }> = [];
  for (const task of tasks) {
    if (!task.repo_path || !task.branch) continue;
    const nwo = await repoNameWithOwner(task.repo_path);
    if (!nwo) continue;
    const [owner, name] = nwo.split('/');
    if (!owner || !name) continue;
    eligible.push({ task, owner, name, branch: task.branch });
  }
  if (eligible.length === 0) return;

  const aliasFragments = eligible
    .map(
      ({ owner, name, branch }, i) =>
        `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequests(headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url } } }`,
    )
    .join('\n  ');
  const query = `query { ${aliasFragments} }`;

  let parsed: {
    data?: Record<
      string,
      { pullRequests: { nodes: Array<{ number: number; url: string }> } } | null
    >;
  } = {};
  try {
    const { stdout } = await execFile('gh', ['api', 'graphql', '-f', `query=${query}`]);
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn('gh rate limit hit on PR detection — backing off until next cycle');
    } else {
      logger.debug({ err: msg }, 'gh api graphql for PR detection failed');
    }
    return;
  }

  for (const [i, { task }] of eligible.entries()) {
    const node = parsed.data?.[`pr${i}`]?.pullRequests?.nodes?.[0];
    const pr = node ? { url: node.url, number: node.number } : null;
    if (pr) {
      // Flip workflow_status to 'pr' if currently in_progress or human_review
      const prevWorkflow = task.workflow_status;
      const shouldFlipToPr = prevWorkflow === 'in_progress' || prevWorkflow === 'human_review';
      setTaskPrDetected(task.id, pr.url, pr.number);

      if (shouldFlipToPr) {
        addTaskUpdate({
          task_id: task.id,
          kind: 'transition',
          from_status: prevWorkflow,
          to_status: 'pr',
          body: 'auto: PR opened',
        });
        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: {
            ...task,
            pr_url: pr.url,
            pr_number: pr.number,
            workflow_status: 'pr' as import('./types.js').WorkflowStatus,
          },
          data: { from: prevWorkflow, to: 'pr', note: 'auto: PR opened' },
        });
      }
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    }
  }
}

// ─── Merged PR Detection ────────────────────────────────────────────────────

export async function checkMergedPRs(): Promise<void> {
  const tasks = listRunningTasksWithPr();

  if (tasks.length === 0) return;

  // Resolve each task's repo to owner/repo so we can fetch all PR states in
  // a single aliased GraphQL query instead of one `gh pr view` per task.
  const eligible: Array<{ task: Task; owner: string; name: string }> = [];
  for (const task of tasks) {
    if (!task.repo_path || !task.pr_number) continue;
    const nwo = await repoNameWithOwner(task.repo_path);
    if (!nwo) continue;
    const [owner, name] = nwo.split('/');
    if (!owner || !name) continue;
    eligible.push({ task, owner, name });
  }
  if (eligible.length === 0) return;

  const aliasFragments = eligible
    .map(
      ({ owner, name, task }, i) =>
        `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${task.pr_number}) { state } }`,
    )
    .join('\n  ');
  const query = `query { ${aliasFragments} }`;

  let parsed: {
    data?: Record<string, { pullRequest: { state: string } | null } | null>;
  } = {};
  try {
    const { stdout } = await execFile('gh', ['api', 'graphql', '-f', `query=${query}`]);
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn('gh rate limit hit on merged-PR check — backing off until next cycle');
    } else {
      logger.debug({ err: msg }, 'gh api graphql for merged PR check failed');
    }
    return;
  }

  for (const [i, { task }] of eligible.entries()) {
    const state = parsed.data?.[`pr${i}`]?.pullRequest?.state;
    if (state === 'MERGED') {
      try {
        const prevWorkflow = task.workflow_status;
        await closeTask(task);
        // Flip workflow_status to 'done' after merge
        setWorkflowStatusDone(task.id);
        addTaskUpdate({
          task_id: task.id,
          kind: 'transition',
          from_status: prevWorkflow,
          to_status: 'done',
          body: 'auto: PR merged',
        });
        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: { ...task, workflow_status: 'done' as import('./types.js').WorkflowStatus },
          data: { from: prevWorkflow, to: 'done', note: 'auto: PR merged' },
        });
        broadcast({ type: 'task:updated', payload: { taskId: task.id } });
      } catch {
        // closeTask failure shouldn't stop processing other tasks
      }
    }
  }
}

export async function pollMergedPRs(): Promise<void> {
  try {
    await checkMergedPRs();
  } catch (err) {
    logger.error({ err, operation: 'pollMergedPRs' }, 'pollMergedPRs failed');
  }
}

// ─── Reviewer-Request Polling ───────────────────────────────────────────────

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

/** List tracked repos — same derivation as GET /api/recent-repos. */
function listTrackedRepos(): string[] {
  const rows = listTaskRepoPaths();
  return rows.map((r) => r.repo_path);
}

/** Parse a git remote URL into `owner/repo` (nameWithOwner) form. Returns null if non-GitHub. */
function parseNameWithOwner(remoteUrl: string): string | null {
  // Matches https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r(.git)
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\s*$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Cache of repoPath → nameWithOwner. Remotes rarely change at runtime.
 * Only successful resolutions are cached so a transient failure (or a repo
 * that gains a GitHub remote later) is retried on the next tick.
 */
const repoNwoCache = new Map<string, string>();

async function repoNameWithOwner(repoPath: string): Promise<string | null> {
  const cached = repoNwoCache.get(repoPath);
  if (cached) return cached;
  try {
    const { stdout } = await execFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    const nwo = parseNameWithOwner(stdout.trim());
    if (nwo) repoNwoCache.set(repoPath, nwo);
    return nwo;
  } catch {
    return null;
  }
}

/** Raw shape returned by GitHub's GraphQL search for the review-requested query. */
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

/**
 * One global GraphQL search for all PRs where the authenticated user is still a
 * requested reviewer, grouped by repository's `owner/repo`. Replaces a per-repo
 * `gh pr list --search` loop (N calls × 10 search points) with a single call.
 */
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

/** Does any reviewRequests entity match the owner login? */
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

/** Pick the first non-stopped agent in a running task, lowest window_index. */
function firstActiveAgent(taskId: string): { id: string; window_index: number } | undefined {
  return findFirstActiveAgent(taskId);
}

/**
 * Nudge the first active agent in a running review task via tmux send-keys.
 * Returns true if the message was delivered.
 */
async function nudgeAgentForReReview(
  taskId: string,
  tmuxSession: string,
  pr: OpenReviewPR,
  previousHeadReachable = true,
): Promise<boolean> {
  const agent = firstActiveAgent(taskId);
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

/**
 * Create or update an auto-review task for a PR where the owner is the requested
 * reviewer. Returns the action taken so the caller can broadcast + log.
 */
async function upsertReviewTask(
  repoPath: string,
  pr: OpenReviewPR,
): Promise<{ action: 'created' | 'updated' | 'nudged' | 'skipped'; taskId?: string }> {
  const existing = findExistingPrTask(repoPath, pr.number);

  if (existing) {
    // Only update rows we created; never touch owner's manual tasks.
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

    // Task is running (or setting_up) — nudge the existing agent rather than
    // creating a duplicate. Record the new SHA so we don't re-nudge on every tick.
    if (existing.runtime_state === 'running' || existing.runtime_state === 'setting_up') {
      if (!existing.tmux_session) return { action: 'skipped' };

      // Fetch + checkout the new head into the worktree so the agent sees it
      // before we nudge. Also probe whether the previous head is reachable; if
      // not the author force-pushed and we tell the agent to do a full re-review.
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

  const short = repoShortName(repoPath);
  const branch = `review/${short}-pr-${pr.number}`;
  const title = `Review: ${pr.title} (#${pr.number})`;
  const description = `Auto-created review task for PR #${pr.number} in ${short}`;
  // Mint the id first so it can be pinned into the orchestrator prompt.
  const id = nanoid(12);
  const prompt = buildReviewPrompt(pr, new Date().toISOString(), id);

  insertReviewTask({
    id,
    repoPath,
    branch,
    baseBranch: pr.baseRefName,
    title,
    description,
    initialPrompt: prompt,
    prUrl: pr.url,
    prNumber: pr.number,
    prHeadSha: pr.headRefOid,
  });
  return { action: 'created', taskId: id };
}

/** Delete auto-review drafts whose triggering PR is no longer awaiting the owner. */
function cleanupResolvedReviewDrafts(repoPath: string, activePrNumbers: Set<number>): string[] {
  const drafts = listAutoReviewDrafts(repoPath);

  const deletedIds: string[] = [];
  for (const draft of drafts) {
    if (draft.pr_number === null) continue;
    if (activePrNumbers.has(draft.pr_number)) continue;
    hardDeleteTask(draft.id);
    // The worktree row was minted alongside the draft (upsertReviewTask) and
    // is unique to it — drop it too so the workspaces list doesn't accumulate
    // an orphan row per resolved PR.
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

  // Resolve each tracked repoPath to its GitHub owner/repo so we can match PRs
  // from a single global GraphQL search back to local worktree roots.
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
        broadcast({ type: 'task:created', payload: { taskId: result.taskId! } });
        const fresh = getTask(result.taskId!);
        if (fresh) {
          try {
            await startTask(fresh);
          } catch (err) {
            logger.error(
              { task_id: result.taskId, err: (err as Error).message },
              'failed to auto-start review task',
            );
          }
        }
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

// ─── Terminal Activity Polling ───────────────────────────────────────────────

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

interface TerminalRow extends UserTerminal {
  tmux_session: string;
}

export async function pollTerminalActivity(): Promise<void> {
  const rows = listRunningTerminals() as TerminalRow[];

  const changedTasks = new Set<string>();
  for (const row of rows) {
    try {
      const { stdout } = await execTmux([
        'list-panes',
        '-t',
        `${row.tmux_session}:${row.window_index}`,
        '-F',
        '#{pane_current_command}',
      ]);
      const command = stdout.trim().split('\n')[0];
      const newStatus = SHELL_COMMANDS.has(command) ? 'idle' : 'working';
      if (newStatus !== row.status) {
        updateUserTerminalStatus(row.id, newStatus);
        changedTasks.add(row.task_id);
      }
    } catch {
      // Window may have been killed — ignore
    }
  }
  for (const taskId of changedTasks) {
    broadcast({ type: 'task:updated', payload: { taskId } });
  }
}

// ─── Watchdog for stuck review_runs ──────────────────────────────────────────

const REVIEW_RUN_TIMEOUT_MIN = 15;

/**
 * Fail review_runs that have been 'running' for longer than the timeout window
 * without producing a walkthrough or any inline comments. Idempotent.
 */
export async function sweepStuckReviewRuns(): Promise<void> {
  const stuck = findStuckReviewRuns(REVIEW_RUN_TIMEOUT_MIN);

  for (const row of stuck) {
    failReviewRunById(row.id, `timeout: no progress for ${REVIEW_RUN_TIMEOUT_MIN} minutes`);
    logger.warn({ task_id: row.task_id, review_run_id: row.id }, 'review_run timed out');
    broadcast({ type: 'review:run-failed', payload: { taskId: row.task_id, reviewRunId: row.id } });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Fire both PR-related GitHub polls together to avoid doubling `gh` usage. */
async function pollPRsAndReviewers(): Promise<void> {
  try {
    await pollPRs();
  } catch (err) {
    logger.error({ err, operation: 'pollPRs' }, 'pollPRs failed');
  }
  try {
    await pollReviewerRequests();
  } catch (err) {
    logger.error({ err, operation: 'pollReviewerRequests' }, 'pollReviewerRequests failed');
  }
  try {
    await sweepStuckReviewRuns();
  } catch (err) {
    logger.error({ err, operation: 'sweepStuckReviewRuns' }, 'sweepStuckReviewRuns failed');
  }
}

// ─── Soft-Delete Purge ───────────────────────────────────────────────────────

export async function pollSoftDeletes(): Promise<void> {
  let hours: number;
  try {
    const settings = await getSettings();
    hours = Math.max(0, settings.deleteGraceHours ?? 6);
  } catch (err) {
    logger.warn({ err, operation: 'pollSoftDeletes' }, 'could not read settings; using default 6h');
    hours = 6;
  }

  const rows = listExpiredSoftDeletes(hours);

  for (const task of rows) {
    try {
      await deleteTask(task);
      hardDeleteTask(task.id);
      broadcast({ type: 'task:deleted', payload: { taskId: task.id } });
      logger.info({ task_id: task.id, operation: 'pollSoftDeletes' }, 'purged soft-deleted task');
    } catch (err) {
      logger.error(
        { err, task_id: task.id, operation: 'pollSoftDeletes' },
        'purge failed; will retry next tick',
      );
    }
  }
}

// ─── Walkthrough Handoff ─────────────────────────────────────────────────────

export async function attachDeepReviewAgent(task: Task): Promise<void> {
  // Claim the handoff ATOMICALLY before the slow addAgent work (tmux new-window +
  // hooks + DB, which can exceed the 5s poll interval). Without this, an
  // overlapping tick — or a crash/retry — would re-select the row (flag still 0)
  // and attach a SECOND deep-review agent. The conditional UPDATE wins the race:
  // only the tick that flips 0→1 proceeds.
  const changes = claimDeepReviewAttach(task.id);
  if (changes !== 1) {
    // Another tick already claimed (or there is no eligible run) — do nothing.
    return;
  }
  const prompt = buildDeepReviewPrompt({ reviewTaskId: task.id });
  await addAgent(task, { prompt });
  logger.info(
    { task_id: task.id, operation: 'attachDeepReviewAgent' },
    'deep-review agent attached',
  );
}

export async function pollWalkthroughHandoffs(): Promise<void> {
  const rows = listWalkthroughHandoffTasks();
  for (const task of rows) {
    try {
      await attachDeepReviewAgent(task);
    } catch (err) {
      logger.error(
        { err, task_id: task.id, operation: 'pollWalkthroughHandoffs' },
        'handoff failed',
      );
    }
  }
}

export function startPolling(): void {
  // Install hooks in any running worktrees that might be missing them
  ensureHooksInstalled();

  if (STATUS_INTERVAL > 0) {
    statusTimer = setInterval(pollStatuses, STATUS_INTERVAL);
  }
  if (PR_INTERVAL > 0) {
    prTimer = setInterval(pollPRsAndReviewers, PR_INTERVAL);
  }
  if (MERGED_PR_INTERVAL > 0) {
    mergedPrTimer = setInterval(pollMergedPRs, MERGED_PR_INTERVAL);
  }
  if (DELETE_INTERVAL > 0) {
    deleteTimer = setInterval(pollSoftDeletes, DELETE_INTERVAL);
  }
  if (TEAM_SCHEDULE_INTERVAL > 0) {
    teamScheduleTimer = setInterval(async () => {
      try {
        const { pollTeamSchedules } = await import('./teams.js');
        await pollTeamSchedules();
      } catch (err) {
        logger.error({ err, operation: 'pollTeamSchedules' }, 'pollTeamSchedules failed');
      }
    }, TEAM_SCHEDULE_INTERVAL);
  }
  if (HANDOFF_INTERVAL > 0) {
    handoffTimer = setInterval(pollWalkthroughHandoffs, HANDOFF_INTERVAL);
  }
  if (APPROVAL_INTERVAL > 0) {
    approvalTimer = setInterval(async () => {
      try {
        const { sweepExpiredApprovalCards } = await import('./orchestrator/approval-timeout.js');
        sweepExpiredApprovalCards();
      } catch (err) {
        logger.error(
          { err, operation: 'sweepExpiredApprovalCards' },
          'approval-timeout sweep failed',
        );
      }
    }, APPROVAL_INTERVAL);
  }
}

export function stopPolling(): void {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (prTimer) {
    clearInterval(prTimer);
    prTimer = null;
  }
  if (mergedPrTimer) {
    clearInterval(mergedPrTimer);
    mergedPrTimer = null;
  }
  if (deleteTimer) {
    clearInterval(deleteTimer);
    deleteTimer = null;
  }
  if (teamScheduleTimer) {
    clearInterval(teamScheduleTimer);
    teamScheduleTimer = null;
  }
  if (handoffTimer) {
    clearInterval(handoffTimer);
    handoffTimer = null;
  }
  if (approvalTimer) {
    clearInterval(approvalTimer);
    approvalTimer = null;
  }
}
