import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { closeTask } from './task-runner.js';
import { installHookSettings } from './hook-settings.js';
import { broadcast } from './events.js';
import { childLogger } from './logger.js';
import { readGithubLogin } from './github-login.js';
import { SELECT_TASK_SQL } from './task-select.js';
import { fireHook } from './hook-dispatcher.js';
import type { Task, UserTerminal } from './types.js';

const logger = childLogger('poller');

const execFile = promisify(execFileCb);

const STATUS_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
const PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 30000;
const MERGED_PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 30000;

let statusTimer: ReturnType<typeof setInterval> | null = null;
let prTimer: ReturnType<typeof setInterval> | null = null;
let mergedPrTimer: ReturnType<typeof setInterval> | null = null;

// ─── Session Status Polling ──────────────────────────────────────────────────

export async function checkTaskStatus(task: Task): Promise<'alive' | 'dead'> {
  if (!task.tmux_session) return 'dead';
  try {
    await execFile('tmux', ['has-session', '-t', task.tmux_session]);
    return 'alive';
  } catch {
    return 'dead';
  }
}

export async function pollStatuses(): Promise<void> {
  const db = getDb();
  // tmux_session IS NOT NULL: a task in 'setting_up' with no session yet is
  // still mid-createTask — skip it so we don't race the setup writing the
  // session column and mark the task 'Setup interrupted' prematurely.
  const runningTasks = db
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up') AND t.tmux_session IS NOT NULL`,
    )
    .all() as Task[];

  const results = await Promise.allSettled(
    runningTasks.map(async (task) => {
      const status = await checkTaskStatus(task);
      return { task, status };
    }),
  );

  const stopAgentsSql = db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ? AND status = 'running'`,
  );
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, status } = result.value;
    if (status !== 'dead') continue;

    const rs = task.runtime_state;
    if (rs === 'running') {
      db.prepare(
        `UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    } else if (rs === 'setting_up') {
      db.prepare(
        `UPDATE tasks SET runtime_state = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    } else {
      continue;
    }
    stopAgentsSql.run(task.id);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  }

  await pollTerminalActivity();
}

// ─── Hook Installation ──────────────────────────────────────────────────────

/**
 * Ensure hooks are installed in all running task worktrees.
 * Handles tasks created before the hook feature existed.
 */
export async function ensureHooksInstalled(): Promise<void> {
  const db = getDb();
  const runningTasks = db
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up') AND w.path IS NOT NULL`,
    )
    .all() as Task[];

  for (const task of runningTasks) {
    try {
      // Worktree settings.local.json is shared across all agents in this task.
      // Pick any agent's hook_token (createTask + addAgent ensure they're all
      // equal). Skip the task if no agent has a token yet — the next agent's
      // creation will install hooks correctly.
      const row = db
        .prepare(`SELECT hook_token FROM agents WHERE task_id = ? AND hook_token != '' LIMIT 1`)
        .get(task.id) as { hook_token: string } | undefined;
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
  const db = getDb();
  const tasks = db
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'idle') AND t.pr_url IS NULL AND w.branch IS NOT NULL`,
    )
    .all() as Task[];

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const pr = await detectPR(task);
      return { task, pr };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, pr } = result.value;
    if (pr) {
      // Flip workflow_status to 'pr' if currently in_progress or human_review
      const prevWorkflow = task.workflow_status;
      const shouldFlipToPr = prevWorkflow === 'in_progress' || prevWorkflow === 'human_review';
      db.prepare(
        `UPDATE tasks SET pr_url = ?, pr_number = ?,
         workflow_status = CASE WHEN workflow_status IN ('in_progress','human_review') THEN 'pr' ELSE workflow_status END,
         updated_at = datetime('now') WHERE id = ?`,
      ).run(pr.url, pr.number, task.id);

      if (shouldFlipToPr) {
        const updateId = nanoid(12);
        db.prepare(
          `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', ?, 'pr', ?)`,
        ).run(updateId, task.id, prevWorkflow, 'auto: PR opened');
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
  const db = getDb();
  const tasks = db
    .prepare(`${SELECT_TASK_SQL} WHERE t.runtime_state = 'running' AND t.pr_number IS NOT NULL`)
    .all() as Task[];

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const { stdout } = await execFile(
        'gh',
        ['pr', 'view', String(task.pr_number), '--json', 'state'],
        {
          cwd: task.repo_path,
        },
      );
      const { state } = JSON.parse(stdout.trim());
      return { task, state };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, state } = result.value;
    if (state === 'MERGED') {
      try {
        const prevWorkflow = task.workflow_status;
        await closeTask(task);
        // Flip workflow_status to 'done' after merge
        db.prepare(
          `UPDATE tasks SET workflow_status = 'done', updated_at = datetime('now') WHERE id = ?`,
        ).run(task.id);
        const updateId = nanoid(12);
        db.prepare(
          `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', ?, 'done', ?)`,
        ).run(updateId, task.id, prevWorkflow, 'auto: PR merged');
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
  const rows = getDb()
    .prepare(
      `SELECT w.repo_path AS repo_path
         FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path IS NOT NULL
        GROUP BY w.repo_path
        ORDER BY MAX(t.created_at) DESC`,
    )
    .all() as Array<{ repo_path: string }>;
  return rows.map((r) => r.repo_path);
}

/** Query `gh` for PRs in a repo where the owner is still a requested reviewer. */
async function fetchReviewRequestedPRs(repoPath: string): Promise<OpenReviewPR[]> {
  try {
    const { stdout } = await execFile(
      'gh',
      [
        'pr',
        'list',
        '--search',
        'review-requested:@me',
        '--state',
        'open',
        '--json',
        'number,title,author,headRefOid,headRefName,baseRefName,url,reviewRequests',
      ],
      { cwd: repoPath },
    );
    const prs = JSON.parse(stdout.trim() || '[]') as OpenReviewPR[];
    return Array.isArray(prs) ? prs : [];
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn({ repo_path: repoPath }, 'gh rate limit hit — backing off until next cycle');
    } else {
      logger.debug(
        { repo_path: repoPath, err: msg },
        'gh pr list failed for tracked repo (no GitHub remote?)',
      );
    }
    return [];
  }
}

/** Does any reviewRequests entity match the owner login? */
function isOwnerStillRequested(pr: OpenReviewPR, ownerLogin: string): boolean {
  return pr.reviewRequests.some(
    (rr) => typeof rr.login === 'string' && rr.login.toLowerCase() === ownerLogin.toLowerCase(),
  );
}

function repoShortName(repoPath: string): string {
  return (
    path
      .basename(repoPath)
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .toLowerCase() || 'repo'
  );
}

function buildReviewPrompt(pr: OpenReviewPR, requestedAt: string): string {
  const author = pr.author?.login ?? 'unknown';
  return [
    `/review-pr ${pr.url}`,
    '',
    `PR: ${pr.title} (#${pr.number}) by @${author}`,
    `Head: ${pr.headRefOid}`,
    `Review requested: ${requestedAt}`,
    '',
    'Use the review-pr skill to post inline comments on GitHub. Keep feedback grounded in the diff.',
  ].join('\n');
}

function buildShaUpdateNote(prompt: string, newSha: string, timestamp: string): string {
  return `${prompt}\n\nUpdated: head advanced to ${newSha} at ${timestamp}`;
}

function buildReReviewNudge(pr: OpenReviewPR): string {
  return (
    `Re-review requested for PR #${pr.number}. ` +
    `Head advanced to ${pr.headRefOid}. ` +
    `Please pull the latest and re-run the /review-pr flow on ${pr.url}.`
  );
}

/** Pick the first non-stopped agent in a running task, lowest window_index. */
function firstActiveAgent(taskId: string): { id: string; window_index: number } | undefined {
  return getDb()
    .prepare(
      `SELECT id, window_index FROM agents
       WHERE task_id = ? AND status != 'stopped'
       ORDER BY window_index ASC LIMIT 1`,
    )
    .get(taskId) as { id: string; window_index: number } | undefined;
}

/**
 * Nudge the first active agent in a running review task via tmux send-keys.
 * Returns true if the message was delivered.
 */
async function nudgeAgentForReReview(
  taskId: string,
  tmuxSession: string,
  pr: OpenReviewPR,
): Promise<boolean> {
  const agent = firstActiveAgent(taskId);
  if (!agent) return false;
  try {
    const target = `${tmuxSession}:${agent.window_index}`;
    const message = buildReReviewNudge(pr);
    await execFile('tmux', ['send-keys', '-t', target, message, 'Enter']);
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
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT t.id AS id, t.runtime_state AS runtime_state,
              t.source AS source,
              t.pr_head_sha AS pr_head_sha, t.initial_prompt AS initial_prompt,
              t.tmux_session AS tmux_session
         FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.pr_number = ?
          AND t.runtime_state != 'error'
        ORDER BY t.created_at DESC LIMIT 1`,
    )
    .get(repoPath, pr.number) as
    | {
        id: string;
        runtime_state: string;
        source: string | null;
        pr_head_sha: string | null;
        initial_prompt: string | null;
        tmux_session: string | null;
      }
    | undefined;

  if (existing) {
    // Only update rows we created; never touch owner's manual tasks.
    if (existing.source !== 'auto_review') return { action: 'skipped' };
    if (existing.pr_head_sha === pr.headRefOid) return { action: 'skipped' };

    if (existing.runtime_state === 'idle') {
      const updatedPrompt = buildShaUpdateNote(
        existing.initial_prompt ?? buildReviewPrompt(pr, new Date().toISOString()),
        pr.headRefOid,
        new Date().toISOString(),
      );
      db.prepare(
        `UPDATE tasks SET pr_head_sha = ?, initial_prompt = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(pr.headRefOid, updatedPrompt, existing.id);
      return { action: 'updated', taskId: existing.id };
    }

    // Task is running (or setting_up) — nudge the existing agent rather than
    // creating a duplicate. Record the new SHA so we don't re-nudge on every tick.
    if (existing.runtime_state === 'running' || existing.runtime_state === 'setting_up') {
      if (!existing.tmux_session) return { action: 'skipped' };
      const delivered = await nudgeAgentForReReview(existing.id, existing.tmux_session, pr);
      if (!delivered) return { action: 'skipped' };
      db.prepare(`UPDATE tasks SET pr_head_sha = ?, updated_at = datetime('now') WHERE id = ?`).run(
        pr.headRefOid,
        existing.id,
      );
      return { action: 'nudged', taskId: existing.id };
    }

    return { action: 'skipped' };
  }

  const id = nanoid(12);
  const short = repoShortName(repoPath);
  const branch = `review/${short}-pr-${pr.number}`;
  const title = `Review: ${pr.title} (#${pr.number})`;
  const description = `Auto-created review task for PR #${pr.number} in ${short}`;
  const prompt = buildReviewPrompt(pr, new Date().toISOString());

  // Materialise a worktree row for the review-branch base before linking the task.
  const worktreeId = nanoid(12);
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES (?, '', ?, ?, ?, 'new', 'available')`,
  ).run(worktreeId, repoPath, branch, pr.baseRefName);

  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, pr_url, pr_number, pr_head_sha,
        initial_prompt, source, worktree_id)
     VALUES (?, ?, ?, 'idle', 'backlog', ?, ?, ?, ?, 'auto_review', ?)`,
  ).run(id, title, description, pr.url, pr.number, pr.headRefOid, prompt, worktreeId);
  return { action: 'created', taskId: id };
}

/** Delete auto-review drafts whose triggering PR is no longer awaiting the owner. */
function cleanupResolvedReviewDrafts(repoPath: string, activePrNumbers: Set<number>): string[] {
  const db = getDb();
  const drafts = db
    .prepare(
      `SELECT t.id AS id, t.pr_number AS pr_number, t.worktree_id AS worktree_id FROM tasks t
         LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.source = 'auto_review' AND t.runtime_state = 'idle'`,
    )
    .all(repoPath) as Array<{ id: string; pr_number: number | null; worktree_id: string | null }>;

  const deletedIds: string[] = [];
  for (const draft of drafts) {
    if (draft.pr_number === null) continue;
    if (activePrNumbers.has(draft.pr_number)) continue;
    db.prepare('DELETE FROM tasks WHERE id = ?').run(draft.id);
    // The worktree row was minted alongside the draft (upsertReviewTask) and
    // is unique to it — drop it too so the workspaces list doesn't accumulate
    // an orphan row per resolved PR.
    if (draft.worktree_id) {
      db.prepare('DELETE FROM worktrees WHERE id = ?').run(draft.worktree_id);
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

  for (const repoPath of repos) {
    const prs = await fetchReviewRequestedPRs(repoPath);
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
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ut.*, t.tmux_session
       FROM user_terminals ut
       JOIN tasks t ON t.id = ut.task_id
       WHERE t.runtime_state = 'running' AND t.tmux_session IS NOT NULL`,
    )
    .all() as TerminalRow[];

  const changedTasks = new Set<string>();
  for (const row of rows) {
    try {
      const { stdout } = await execFile('tmux', [
        'list-panes',
        '-t',
        `${row.tmux_session}:${row.window_index}`,
        '-F',
        '#{pane_current_command}',
      ]);
      const command = stdout.trim().split('\n')[0];
      const newStatus = SHELL_COMMANDS.has(command) ? 'idle' : 'working';
      if (newStatus !== row.status) {
        db.prepare('UPDATE user_terminals SET status = ? WHERE id = ?').run(newStatus, row.id);
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
}
