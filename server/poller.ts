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
  const runningTasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('running', 'setting_up')")
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

    if (task.status === 'running') {
      db.prepare(
        `UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    } else if (task.status === 'setting_up') {
      db.prepare(
        `UPDATE tasks SET status = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
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
export function ensureHooksInstalled(): void {
  const db = getDb();
  const runningTasks = db
    .prepare(
      "SELECT * FROM tasks WHERE status IN ('running', 'setting_up') AND worktree IS NOT NULL",
    )
    .all() as Task[];

  for (const task of runningTasks) {
    try {
      installHookSettings(task.worktree!);
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
      "SELECT * FROM tasks WHERE status IN ('running', 'closed') AND pr_url IS NULL AND branch IS NOT NULL",
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
      db.prepare(
        `UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(pr.url, pr.number, task.id);
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    }
  }
}

// ─── Merged PR Detection ────────────────────────────────────────────────────

export async function checkMergedPRs(): Promise<void> {
  const db = getDb();
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status = 'running' AND pr_number IS NOT NULL")
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
        await closeTask(task);
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
    .prepare(`SELECT repo_path FROM tasks GROUP BY repo_path ORDER BY MAX(created_at) DESC`)
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

/**
 * Create or update a draft review task for a PR where the owner is the requested
 * reviewer. Returns the action taken so the caller can broadcast + log.
 */
function upsertReviewTask(
  repoPath: string,
  pr: OpenReviewPR,
): { action: 'created' | 'updated' | 'skipped'; taskId?: string } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, status, source, pr_head_sha, initial_prompt
       FROM tasks
       WHERE repo_path = ? AND pr_number = ? AND status NOT IN ('closed', 'error')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repoPath, pr.number) as
    | {
        id: string;
        status: string;
        source: string | null;
        pr_head_sha: string | null;
        initial_prompt: string | null;
      }
    | undefined;

  if (existing) {
    // Only update rows we created; never touch owner's manual tasks.
    if (existing.source !== 'auto_review') return { action: 'skipped' };
    if (existing.status !== 'draft') return { action: 'skipped' };
    if (existing.pr_head_sha === pr.headRefOid) return { action: 'skipped' };

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

  const id = nanoid(12);
  const short = repoShortName(repoPath);
  const branch = `review/${short}-pr-${pr.number}`;
  const title = `Review: ${pr.title} (#${pr.number})`;
  const description = `Auto-created review task for PR #${pr.number} in ${short}`;
  const prompt = buildReviewPrompt(pr, new Date().toISOString());

  db.prepare(
    `INSERT INTO tasks
       (id, title, description, repo_path, status, branch, base_branch, pr_url, pr_number,
        pr_head_sha, initial_prompt, source)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 'auto_review')`,
  ).run(
    id,
    title,
    description,
    repoPath,
    branch,
    pr.baseRefName,
    pr.url,
    pr.number,
    pr.headRefOid,
    prompt,
  );
  return { action: 'created', taskId: id };
}

/** Delete auto-review drafts whose triggering PR is no longer awaiting the owner. */
function cleanupResolvedReviewDrafts(repoPath: string, activePrNumbers: Set<number>): string[] {
  const db = getDb();
  const drafts = db
    .prepare(
      `SELECT id, pr_number FROM tasks
       WHERE repo_path = ? AND source = 'auto_review' AND status = 'draft'`,
    )
    .all(repoPath) as Array<{ id: string; pr_number: number | null }>;

  const deletedIds: string[] = [];
  for (const draft of drafts) {
    if (draft.pr_number === null) continue;
    if (activePrNumbers.has(draft.pr_number)) continue;
    db.prepare('DELETE FROM tasks WHERE id = ?').run(draft.id);
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

      const result = upsertReviewTask(repoPath, pr);
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
       WHERE t.status = 'running' AND t.tmux_session IS NOT NULL`,
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
