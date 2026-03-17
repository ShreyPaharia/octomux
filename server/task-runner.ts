import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { installHookSettings } from './hook-settings.js';
import type { Task, Agent } from './types.js';

const execFile = promisify(execFileCb);

const CLAUDE_READY_TIMEOUT = process.env.NODE_ENV === 'test' ? 0 : 30_000;
const CLAUDE_READY_POLL_INTERVAL = 500;
const POST_READY_SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 500;
const PASTE_TO_ENTER_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 150;

/** Get the active window index of a tmux session. */
async function getActiveWindowIndex(session: string): Promise<number> {
  const { stdout } = await execFile('tmux', [
    'display-message',
    '-t',
    session,
    '-p',
    '#{window_index}',
  ]);
  return parseInt(stdout.trim(), 10);
}

/** Get the index of the last window in a tmux session. */
async function getLastWindowIndex(session: string): Promise<number> {
  const { stdout } = await execFile('tmux', [
    'list-windows',
    '-t',
    session,
    '-F',
    '#{window_index}',
  ]);
  const indices = stdout.trim().split('\n').map(Number);
  return Math.max(...indices);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll tmux pane content until Claude Code's TUI is ready for input.
 *
 * Two-phase detection prevents false positives:
 *   Phase 1 — Wait for the pane content to show that Claude's TUI has taken
 *             over from the shell.  The shell prompt (which may itself contain
 *             `>` or `❯`) must no longer be visible.  We detect this by waiting
 *             until the pane no longer contains the `claude` launch command text.
 *   Phase 2 — Poll for Claude's `❯` (or `>`) input prompt, which appears once
 *             the Ink-based TUI has fully initialized.
 *
 * A post-ready settle delay lets Ink wire up its stdin handler before dispatch.
 * Falls back to proceeding after timeout (best-effort).
 */
export async function waitForClaudeReady(
  session: string,
  windowIndex: number,
  timeoutMs: number = CLAUDE_READY_TIMEOUT,
): Promise<void> {
  if (timeoutMs === 0) return; // skip in tests
  const target = `${session}:${windowIndex}`;
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  // Phase 1: Wait for the shell to hand off to Claude's TUI.
  // After `send-keys "claude ..." Enter`, the pane still shows the shell prompt
  // and the command text.  Once Ink clears the screen, that text disappears.
  while (elapsed() < timeoutMs) {
    try {
      const { stdout } = await execFile('tmux', ['capture-pane', '-t', target, '-p']);
      const content = stdout.trim();
      // Ink has taken over once the launch command is no longer visible
      if (
        content.length > 0 &&
        !content.includes('claude --session-id') &&
        !content.includes('claude --resume')
      ) {
        break;
      }
    } catch {
      // pane may not exist yet — keep polling
    }
    await sleep(CLAUDE_READY_POLL_INTERVAL);
  }

  // Phase 2: Poll for Claude's input prompt character.
  while (elapsed() < timeoutMs) {
    try {
      const { stdout } = await execFile('tmux', ['capture-pane', '-t', target, '-p']);
      const lines = stdout.split('\n');
      // Match the bare prompt line (e.g. "❯ " or "> ") — not a trust-dialog
      // select cursor like "❯ 1. Yes, I trust this folder".
      if (lines.some((line) => /^\s*[>❯]\s*$/.test(line))) {
        // Let Ink's input handler finish wiring up before we dispatch.
        await sleep(POST_READY_SETTLE_MS);
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(CLAUDE_READY_POLL_INTERVAL);
  }

  // Timeout — proceed anyway (best-effort)
  console.warn(
    `[octomux] waitForClaudeReady timed out after ${timeoutMs}ms for ${target} — proceeding best-effort`,
  );
}

/**
 * Kill all linked viewer sessions (`<tmuxSession>-v-*`) for a specific task.
 * Safe to call even if no linked sessions exist.
 */
export async function cleanupLinkedSessions(tmuxSession: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('tmux', ['list-sessions', '-F', '#{session_name}']));
  } catch {
    return; // tmux server not running or no sessions
  }

  const prefix = `${tmuxSession}-v-`;
  const linked = stdout
    .trim()
    .split('\n')
    .filter((name) => name.startsWith(prefix));

  for (const session of linked) {
    await execFile('tmux', ['kill-session', '-t', session]).catch(() => {});
  }
}

/**
 * Clean up orphaned `-v-` viewer sessions from previous runs.
 * Only kills linked sessions whose parent session no longer exists.
 */
export async function cleanupOrphanedViewerSessions(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('tmux', ['list-sessions', '-F', '#{session_name}']));
  } catch {
    return;
  }

  const sessions = new Set(stdout.trim().split('\n').filter(Boolean));
  const viewerPattern = /^(octomux-agent-.+)-v-/;

  for (const name of sessions) {
    const match = name.match(viewerPattern);
    if (match) {
      const parentSession = match[1];
      if (!sessions.has(parentSession)) {
        await execFile('tmux', ['kill-session', '-t', name]).catch(() => {});
      }
    }
  }
}

/** Generate a git-safe branch slug from a title + task ID suffix. */
export function slugifyTitle(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // replace non-alphanumeric with hyphens
    .replace(/-{2,}/g, '-') // collapse consecutive hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    .slice(0, 50);
  const suffix = id.slice(0, 6);
  return `${slug}-${suffix}`;
}

export async function startTask(task: Task): Promise<void> {
  const db = getDb();
  const id = task.id;
  const session = `octomux-agent-${id}`;
  const slug = slugifyTitle(task.title, id);
  const branch = task.branch || `agents/${slug}`;
  const worktreeDir = task.branch || slug;
  const worktreePath = path.join(task.repo_path, '.worktrees', worktreeDir);

  try {
    // 1. Update status to setting_up
    db.prepare(
      `UPDATE tasks SET status = ?, tmux_session = ?, branch = ?, worktree = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run('setting_up', session, branch, worktreePath, id);

    // 2. Validate repo path
    if (!fs.existsSync(task.repo_path)) {
      throw new Error(`Repository path does not exist: ${task.repo_path}`);
    }
    await execFile('git', ['-C', task.repo_path, 'rev-parse', '--is-inside-work-tree']);

    // 3. Ensure .worktrees directory exists
    const worktreeBaseDir = path.join(task.repo_path, '.worktrees');
    fs.mkdirSync(worktreeBaseDir, { recursive: true });

    // 4. Create worktree (optionally from a base branch)
    const worktreeArgs = ['-C', task.repo_path, 'worktree', 'add', worktreePath, '-b', branch];
    if (task.base_branch) {
      worktreeArgs.push(task.base_branch);
    }
    await execFile('git', worktreeArgs);

    // 5. Copy .claude/settings.local.json if it exists
    const settingsSrc = path.join(task.repo_path, '.claude', 'settings.local.json');
    const settingsDst = path.join(worktreePath, '.claude', 'settings.local.json');
    if (fs.existsSync(settingsSrc)) {
      fs.mkdirSync(path.dirname(settingsDst), { recursive: true });
      fs.copyFileSync(settingsSrc, settingsDst);
    }

    // 5b. Install hook settings for permission tracking
    installHookSettings(worktreePath);

    // 6. Create tmux session
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', worktreePath]);
    // Prevent grouped viewer sessions from constraining window size
    await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);

    // 7. Query the actual window index (respects tmux base-index)
    const windowIndex = await getActiveWindowIndex(session);

    // 8. Create first agent record with session ID
    const agentId = nanoid(12);
    const claudeSessionId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO agents (id, task_id, window_index, label, claude_session_id) VALUES (?, ?, ?, ?, ?)',
    ).run(agentId, id, windowIndex, 'Agent 1', claudeSessionId);

    // 9. Launch claude in the window with session tracking
    await execFile('tmux', [
      'send-keys',
      '-t',
      `${session}:${windowIndex}`,
      `claude --session-id ${claudeSessionId}`,
      'Enter',
    ]);

    // 10. Wait for Claude to be ready, then dispatch initial prompt
    if (task.initial_prompt) {
      await waitForClaudeReady(session, windowIndex);
      await dispatchToWindow(session, windowIndex, task.initial_prompt);
    }

    // 12. Mark as running
    db.prepare(`UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
      'running',
      id,
    );
  } catch (err) {
    db.prepare(
      `UPDATE tasks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run('error', (err as Error).message, id);
  }
}

export async function addAgent(task: Task, prompt?: string): Promise<Agent> {
  const db = getDb();

  // Determine label from active (non-stopped) agent count
  const activeAgents = db
    .prepare(`SELECT * FROM agents WHERE task_id = ? AND status != 'stopped' ORDER BY window_index`)
    .all(task.id) as Agent[];
  const label = `Agent ${activeAgents.length + 1}`;

  // Create new tmux window
  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);

  // Query the actual window index of the newly created window
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  // Create agent record with session ID
  const agentId = nanoid(12);
  const claudeSessionId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO agents (id, task_id, window_index, label, claude_session_id) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, task.id, windowIndex, label, claudeSessionId);

  // Launch claude with session tracking
  await execFile('tmux', [
    'send-keys',
    '-t',
    `${task.tmux_session}:${windowIndex}`,
    `claude --session-id ${claudeSessionId}`,
    'Enter',
  ]);

  // Dispatch prompt if provided
  if (prompt) {
    await waitForClaudeReady(task.tmux_session!, windowIndex);
    await dispatchToWindow(task.tmux_session!, windowIndex, prompt);
  }

  return {
    id: agentId,
    task_id: task.id,
    window_index: windowIndex,
    label,
    status: 'running',
    claude_session_id: claudeSessionId,
    hook_activity: 'active' as const,
    hook_activity_updated_at: null,
    created_at: new Date().toISOString(),
  };
}

export async function closeTask(task: Task): Promise<void> {
  const db = getDb();

  // Resolve all pending permission prompts for this task
  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE task_id = ? AND status = 'pending'`,
  ).run(task.id);

  // Mark task as closed and all agents as stopped
  db.prepare(`UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(
    task.id,
  );
  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ?`,
  ).run(task.id);

  // Kill linked viewer sessions, then main tmux session — worktree and branch are preserved for resume
  if (task.tmux_session) {
    await cleanupLinkedSessions(task.tmux_session);
    await execFile('tmux', ['kill-session', '-t', task.tmux_session]).catch(() => {});
  }
}

export async function deleteTask(task: Task): Promise<void> {
  // Kill linked viewer sessions, then main tmux session
  if (task.tmux_session) {
    await cleanupLinkedSessions(task.tmux_session);
    await execFile('tmux', ['kill-session', '-t', task.tmux_session]).catch(() => {});
  }

  // Remove worktree
  if (task.worktree) {
    await execFile('git', [
      '-C',
      task.repo_path,
      'worktree',
      'remove',
      task.worktree,
      '--force',
    ]).catch(() => {});
  }

  // Delete branch
  if (task.branch) {
    await execFile('git', ['-C', task.repo_path, 'branch', '-D', task.branch]).catch(() => {});
  }
}

export async function stopAgent(task: Task, agent: Agent): Promise<void> {
  const db = getDb();

  // Resolve pending permission prompts for this agent
  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE agent_id = ? AND status = 'pending'`,
  ).run(agent.id);

  // Kill the specific tmux window
  await execFile('tmux', ['kill-window', '-t', `${task.tmux_session}:${agent.window_index}`]).catch(
    () => {},
  );

  // Mark agent as stopped and idle
  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE id = ?`,
  ).run(agent.id);
}

export async function createUserTerminal(task: Task): Promise<number> {
  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return task.user_window_index;
  }

  const db = getDb();

  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);

  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  await execFile('tmux', [
    'send-keys',
    '-t',
    `${task.tmux_session}:${windowIndex}`,
    'nvim .',
    'Enter',
  ]);

  db.prepare(
    `UPDATE tasks SET user_window_index = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(windowIndex, task.id);

  return windowIndex;
}

export async function resumeTask(task: Task): Promise<void> {
  const db = getDb();
  const session = task.tmux_session!;

  try {
    // 1. Set status synchronously to prevent poller race
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', error = NULL, user_window_index = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    // 2. Kill any stale linked viewer sessions and tmux session
    await cleanupLinkedSessions(session);
    await execFile('tmux', ['kill-session', '-t', session]).catch(() => {});

    // 3. Create fresh tmux session
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', task.worktree!]);
    await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);

    // 3b. Install hook settings for permission tracking
    installHookSettings(task.worktree!);

    // 4. Get stopped agents
    const agents = db
      .prepare(
        `SELECT * FROM agents WHERE task_id = ? AND status = 'stopped' ORDER BY window_index`,
      )
      .all(task.id) as Agent[];

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      let windowIndex: number;

      if (i === 0) {
        // Use the initial session window
        windowIndex = await getActiveWindowIndex(session);
      } else {
        // Create new window for subsequent agents
        await execFile('tmux', ['new-window', '-t', session, '-c', task.worktree!]);
        windowIndex = await getLastWindowIndex(session);
      }

      // Launch claude with resume or continue
      let claudeCmd: string;
      if (agent.claude_session_id) {
        claudeCmd = `claude --resume ${agent.claude_session_id}`;
      } else {
        const newSessionId = crypto.randomUUID();
        claudeCmd = `claude --continue --session-id ${newSessionId}`;
        db.prepare('UPDATE agents SET claude_session_id = ? WHERE id = ?').run(
          newSessionId,
          agent.id,
        );
      }
      await execFile('tmux', ['send-keys', '-t', `${session}:${windowIndex}`, claudeCmd, 'Enter']);

      // Update agent record
      db.prepare(`UPDATE agents SET window_index = ?, status = 'running' WHERE id = ?`).run(
        windowIndex,
        agent.id,
      );
    }

    // 5. Mark task as running
    db.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);
  } catch (err) {
    db.prepare(
      `UPDATE tasks SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run((err as Error).message, task.id);
  }
}

export async function dispatchToWindow(
  session: string,
  windowIndex: number,
  text: string,
): Promise<void> {
  const target = `${session}:${windowIndex}`;
  const bufferName = `octomux-${nanoid(8)}`;

  // Load text into a named tmux buffer (avoids race with concurrent dispatches).
  // Do NOT append '\n' — send-keys Enter handles submission separately.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tmux', ['load-buffer', '-b', bufferName, '-']);
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux load-buffer exited with code ${code}`));
    });
  });

  // Paste named buffer into the target window, -d deletes buffer after paste
  await execFile('tmux', ['paste-buffer', '-b', bufferName, '-d', '-t', target]);

  // Let the TUI process the pasted text before submitting
  await sleep(PASTE_TO_ENTER_DELAY_MS);

  // Press Enter to submit the prompt
  await execFile('tmux', ['send-keys', '-t', target, 'Enter']);
}
