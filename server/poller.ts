import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db.js';
import type { Task } from './types.js';

const execFile = promisify(execFileCb);

const STATUS_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
const PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 30000;

let statusTimer: ReturnType<typeof setInterval> | null = null;
let prTimer: ReturnType<typeof setInterval> | null = null;

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

  for (const task of runningTasks) {
    const status = await checkTaskStatus(task);
    if (status === 'dead' && task.status === 'running') {
      // Session died unexpectedly — mark as closed
      db.prepare(`UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(
        task.id,
      );

      // Mark all running agents as stopped
      db.prepare(
        "UPDATE agents SET status = 'stopped' WHERE task_id = ? AND status = 'running'",
      ).run(task.id);
    } else if (status === 'dead' && task.status === 'setting_up') {
      db.prepare(
        `UPDATE tasks SET status = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);

      db.prepare(
        "UPDATE agents SET status = 'stopped' WHERE task_id = ? AND status = 'running'",
      ).run(task.id);
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

  for (const task of tasks) {
    const pr = await detectPR(task);
    if (pr) {
      db.prepare(
        `UPDATE tasks SET pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(pr.url, pr.number, task.id);
    }
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function startPolling(): void {
  if (STATUS_INTERVAL > 0) {
    statusTimer = setInterval(pollStatuses, STATUS_INTERVAL);
  }
  if (PR_INTERVAL > 0) {
    prTimer = setInterval(pollPRs, PR_INTERVAL);
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
}
