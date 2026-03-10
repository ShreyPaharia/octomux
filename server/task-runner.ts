import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import type { Task, Agent } from './types.js';

const execFile = promisify(execFileCb);

const CLAUDE_INIT_DELAY = process.env.NODE_ENV === 'test' ? 0 : 3000;

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

export async function startTask(task: Task): Promise<void> {
  const db = getDb();
  const id = task.id;
  const session = `octomux-agent-${id}`;
  const branch = task.branch || `agents/${id}`;
  const worktreeDir = task.branch || id;
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
    const worktreeDir = path.join(task.repo_path, '.worktrees');
    fs.mkdirSync(worktreeDir, { recursive: true });

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

    // 6. Create tmux session
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', worktreePath]);

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

    // 10. Wait for claude to initialize
    await sleep(CLAUDE_INIT_DELAY);

    // 11. Dispatch initial prompt (if provided)
    if (task.initial_prompt) {
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
    await sleep(CLAUDE_INIT_DELAY);
    await dispatchToWindow(task.tmux_session!, windowIndex, prompt);
  }

  return {
    id: agentId,
    task_id: task.id,
    window_index: windowIndex,
    label,
    status: 'running',
    claude_session_id: claudeSessionId,
    created_at: new Date().toISOString(),
  };
}

export async function closeTask(task: Task): Promise<void> {
  const db = getDb();

  // Mark all agents as stopped
  db.prepare('UPDATE agents SET status = ? WHERE task_id = ?').run('stopped', task.id);

  // Kill tmux session
  if (task.tmux_session) {
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

  // Branch is always kept — work is preserved
}

export async function stopAgent(task: Task, agent: Agent): Promise<void> {
  const db = getDb();

  // Kill the specific tmux window
  await execFile('tmux', ['kill-window', '-t', `${task.tmux_session}:${agent.window_index}`]).catch(
    () => {},
  );

  // Mark agent as stopped
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('stopped', agent.id);
}

export async function resumeTask(task: Task): Promise<void> {
  const db = getDb();
  const session = task.tmux_session!;

  try {
    // 1. Set status synchronously to prevent poller race
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', error = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    // 2. Kill any stale tmux session
    await execFile('tmux', ['kill-session', '-t', session]).catch(() => {});

    // 3. Create fresh tmux session
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', task.worktree!]);

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
      const claudeCmd = agent.claude_session_id
        ? `claude --resume ${agent.claude_session_id}`
        : 'claude --continue';
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

  // tmux load-buffer reads from stdin
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tmux', ['load-buffer', '-']);
    proc.stdin.write(text + '\n');
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux load-buffer exited with code ${code}`));
    });
  });

  // Paste into the target window
  await execFile('tmux', ['paste-buffer', '-t', target]);

  // Press Enter to submit the prompt
  await execFile('tmux', ['send-keys', '-t', target, 'Enter']);
}
