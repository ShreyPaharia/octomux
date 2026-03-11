import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db.js';
import { closeTask } from './task-runner.js';
import { installHookSettings } from './hook-settings.js';
import type { Task } from './types.js';

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

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, status } = result.value;

    if (status === 'dead' && task.status === 'running') {
      db.prepare(
        `UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(
        `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ? AND status = 'running'`,
      ).run(task.id);
    } else if (status === 'dead' && task.status === 'setting_up') {
      db.prepare(
        `UPDATE tasks SET status = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(
        `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ? AND status = 'running'`,
      ).run(task.id);
    }
  }
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
    console.error('pollMergedPRs error:', err);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function startPolling(): void {
  // Install hooks in any running worktrees that might be missing them
  ensureHooksInstalled();

  if (STATUS_INTERVAL > 0) {
    statusTimer = setInterval(pollStatuses, STATUS_INTERVAL);
  }
  if (PR_INTERVAL > 0) {
    prTimer = setInterval(pollPRs, PR_INTERVAL);
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
