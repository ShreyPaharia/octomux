import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { installHookSettings } from './hook-settings.js';
import { getSettings, resolveClaudeFlags } from './settings.js';
import { getOrCreateRepoConfig } from './repo-config.js';
import { childLogger } from './logger.js';
import type { RepoConfig } from './repo-config.js';
import type { Task, Agent, UserTerminal } from './types.js';

const logger = childLogger('task-runner');

export interface UserTerminalResult {
  editor: 'nvim' | 'vscode' | 'cursor';
  windowIndex: number | null;
}

const execFile = promisify(execFileCb);

/**
 * Resolve extra claude CLI flags from env var (if set) or settings.
 * Returns a string with a leading space, or '' when empty.
 */
async function getClaudeFlags(): Promise<string> {
  return resolveClaudeFlags(await getSettings());
}

/**
 * True when an execFile error stems from tmux reporting that a target
 * session/window/pane does not exist — which happens routinely during cleanup
 * (session already killed, window already closed) and is not worth a warn.
 */
function isTmuxTargetMissing(err: unknown): boolean {
  const stderr = (err as { stderr?: string } | null)?.stderr ?? '';
  return /can't find (?:session|window|pane):/i.test(stderr);
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROMPT_FILE_CLEANUP_MS = 5000;

function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write `prompt` to a temp file inside `worktreePath`, send `baseCmd "$(cat <file>)"`
 * as a tmux send-keys to `target`, then clean up the file after a delay. If `prompt`
 * is absent, sends `baseCmd` as-is.
 */
async function sendClaudeCommand(args: {
  target: string;
  baseCmd: string;
  prompt?: string | null;
  worktreePath?: string;
  agentId?: string;
}): Promise<void> {
  let cmd = args.baseCmd;
  let promptFile: string | null = null;
  if (args.prompt && args.worktreePath && args.agentId) {
    promptFile = path.join(args.worktreePath, `.claude-prompt-${args.agentId}`);
    fs.writeFileSync(promptFile, args.prompt);
    cmd += ` "$(cat ${shellQuoteSingle(promptFile)})"`;
  }
  await waitForShellReady(args.target);
  await execFile('tmux', ['send-keys', '-t', args.target, cmd, 'Enter']);
  if (promptFile) {
    const pf = promptFile;
    setTimeout(() => {
      try {
        fs.unlinkSync(pf);
      } catch {
        // already removed or never existed
      }
    }, PROMPT_FILE_CLEANUP_MS);
  }
}

export async function preflightWorktree(worktreePath: string, config: RepoConfig): Promise<void> {
  // Auto-fix formatting drift
  try {
    await execFile('sh', ['-c', config.format_command], { cwd: worktreePath });
  } catch {
    // Non-critical: repo may not have this script
  }

  // Auto-fix lint issues
  try {
    await execFile('sh', ['-c', config.lint_command], { cwd: worktreePath });
  } catch {
    // Non-critical
  }

  // Commit any auto-fixes as a clean baseline
  const { stdout: diff } = await execFile('git', ['diff', '--name-only'], { cwd: worktreePath });
  if (diff.trim()) {
    await execFile('git', ['add', '-A'], { cwd: worktreePath });
    await execFile('git', ['commit', '-m', 'chore: fix pre-existing formatting'], {
      cwd: worktreePath,
    });
  }
}

/**
 * Wait for the shell in a tmux pane to be ready by polling for a shell prompt.
 * This prevents the classic tmux race condition where send-keys fires before
 * the shell has initialized, causing the first character(s) to be swallowed.
 *
 * Starts with a short warm-up sleep (most shells render their prompt within
 * a couple hundred ms) so we don't burn a subprocess on the guaranteed miss,
 * then polls at 250ms intervals up to the timeout.
 */
async function waitForShellReady(
  target: string,
  timeoutMs = 5000,
  intervalMs = 250,
  initialDelayMs = 200,
): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await sleep(initialDelayMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFile('tmux', ['capture-pane', '-t', target, '-p']);
      // Look for common shell prompts: $, %, >, ❯, or the user@host pattern
      if (/[$%>❯#]\s*$/m.test(stdout)) return;
    } catch {
      // pane may not exist yet
    }
    await sleep(intervalMs);
  }
  // Best-effort: proceed after timeout even if prompt not detected
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
    .normalize('NFKD') // decompose accents so they can be stripped
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
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
  const isNoWorktree = !!task.no_worktree;

  logger.info(
    { task_id: id, operation: 'createTask', no_worktree: isNoWorktree, repo_path: task.repo_path },
    'createTask: start',
  );

  let stage = 'validate_repo';
  try {
    // 1. Validate repo path
    if (!fs.existsSync(task.repo_path)) {
      throw new Error(`Repository path does not exist: ${task.repo_path}`);
    }
    await execFile('git', ['-C', task.repo_path, 'rev-parse', '--is-inside-work-tree']);

    let worktreePath: string;
    let branch: string | null = null;

    stage = 'worktree_setup';
    logger.info({ task_id: id, operation: 'createTask', stage }, 'createTask: setting up worktree');

    if (isNoWorktree) {
      // No-worktree mode: run directly in repo. repo_path already exists, so it's
      // safe to persist worktree now. tmux_session is deferred to after new-session.
      worktreePath = task.repo_path;
      db.prepare(
        `UPDATE tasks SET status = ?, branch = NULL, worktree = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run('setting_up', worktreePath, id);
    } else {
      // Standard mode: create worktree and branch. We intentionally do NOT
      // persist worktree or tmux_session yet — pollStatuses treats any task in
      // (running, setting_up) with a tmux_session as eligible for the
      // has-session liveness check, so writing tmux_session before the session
      // exists causes the poller to race with us and mark the task
      // status='error', error='Setup interrupted'. Defer each column write
      // until its resource actually exists on disk / in tmux.
      const slug = slugifyTitle(task.title, id);
      branch = task.branch || `agents/${slug}`;
      const worktreeDir = task.branch || slug;
      worktreePath = path.join(task.repo_path, '.worktrees', worktreeDir);

      db.prepare(
        `UPDATE tasks SET status = ?, branch = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run('setting_up', branch, id);

      // Ensure .worktrees directory exists
      const worktreeBaseDir = path.join(task.repo_path, '.worktrees');
      fs.mkdirSync(worktreeBaseDir, { recursive: true });

      // Create worktree (optionally from a base branch)
      const worktreeArgs = ['-C', task.repo_path, 'worktree', 'add', worktreePath, '-b', branch];
      if (task.base_branch) {
        worktreeArgs.push(task.base_branch);
      }
      await execFile('git', worktreeArgs);

      // Worktree exists on disk now — persist the column so recovery can see it.
      db.prepare(`UPDATE tasks SET worktree = ?, updated_at = datetime('now') WHERE id = ?`).run(
        worktreePath,
        id,
      );

      logger.info(
        { task_id: id, operation: 'createTask', branch, worktree: worktreePath },
        'createTask: branch created',
      );

      // Copy .claude/settings.local.json if it exists
      const settingsSrc = path.join(task.repo_path, '.claude', 'settings.local.json');
      const settingsDst = path.join(worktreePath, '.claude', 'settings.local.json');
      if (fs.existsSync(settingsSrc)) {
        fs.mkdirSync(path.dirname(settingsDst), { recursive: true });
        fs.copyFileSync(settingsSrc, settingsDst);
      }
    }

    // Install hook settings
    installHookSettings(worktreePath);

    // Pre-flight: auto-fix formatting in fresh worktree (only for worktree tasks)
    if (!isNoWorktree) {
      stage = 'preflight';
      const repoConfig = await getOrCreateRepoConfig(task.repo_path);
      await preflightWorktree(worktreePath, repoConfig);
    }

    // Create tmux session
    stage = 'tmux_session';
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', worktreePath]);
    // Prevent grouped viewer sessions from constraining window size
    await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);
    // Session exists now — persist the column. See race-avoidance comment above.
    db.prepare(`UPDATE tasks SET tmux_session = ?, updated_at = datetime('now') WHERE id = ?`).run(
      session,
      id,
    );
    logger.info(
      { task_id: id, operation: 'createTask', tmux_session: session },
      'createTask: tmux session created',
    );

    // 7. Query the actual window index (respects tmux base-index)
    const windowIndex = await getActiveWindowIndex(session);

    // 8. Create first agent record with session ID
    stage = 'launch_agent';
    const agentId = nanoid(12);
    const claudeSessionId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO agents (id, task_id, window_index, label, claude_session_id) VALUES (?, ?, ?, ?, ?)',
    ).run(agentId, id, windowIndex, 'Agent 1', claudeSessionId);

    // Launch claude in the window. Prompt (if any) goes via a tempfile to avoid
    // shell-escape hazards in the user-supplied prompt content.
    const flags = await getClaudeFlags();
    await sendClaudeCommand({
      target: `${session}:${windowIndex}`,
      baseCmd: `claude --session-id ${claudeSessionId}${flags}`,
      prompt: task.initial_prompt,
      worktreePath,
      agentId,
    });
    logger.info(
      {
        task_id: id,
        agent_id: agentId,
        operation: 'createTask',
        window_index: windowIndex,
        claude_session_id: claudeSessionId,
      },
      'createTask: first agent launched',
    );

    // 12. Mark as running. Clear error too — otherwise a transient error value
    // (e.g. written by the poller during a pre-fix race, or by a prior failed
    // setup attempt) would linger on a successfully running task.
    db.prepare(
      `UPDATE tasks SET status = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run('running', id);
    logger.info({ task_id: id, operation: 'createTask' }, 'createTask: complete');
  } catch (err) {
    logger.error(
      { task_id: id, operation: 'createTask', stage, err },
      'createTask: failed during setup stage',
    );
    db.prepare(
      `UPDATE tasks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run('error', (err as Error).message, id);
  }
}

export async function addAgent(task: Task, prompt?: string): Promise<Agent> {
  const db = getDb();

  logger.info({ task_id: task.id, operation: 'addAgent' }, 'addAgent: start');

  // Determine label from active (non-stopped) agent count
  const activeAgents = db
    .prepare(`SELECT * FROM agents WHERE task_id = ? AND status != 'stopped' ORDER BY window_index`)
    .all(task.id) as Agent[];
  const label = `Agent ${activeAgents.length + 1}`;

  // Create new tmux window
  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);

  // Query the actual window index of the newly created window
  const windowIndex = await getLastWindowIndex(task.tmux_session!);
  logger.info(
    { task_id: task.id, operation: 'addAgent', window_index: windowIndex, label },
    'addAgent: tmux window created',
  );

  // Create agent record with session ID
  const agentId = nanoid(12);
  const claudeSessionId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO agents (id, task_id, window_index, label, claude_session_id) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, task.id, windowIndex, label, claudeSessionId);

  // Launch claude asynchronously — do not block the HTTP response
  const addTarget = `${task.tmux_session}:${windowIndex}`;
  const flags = await getClaudeFlags();
  (async () => {
    try {
      await sendClaudeCommand({
        target: addTarget,
        baseCmd: `claude --session-id ${claudeSessionId}${flags}`,
        prompt,
        worktreePath: task.worktree!,
        agentId,
      });
      logger.info(
        {
          task_id: task.id,
          agent_id: agentId,
          operation: 'addAgent',
          window_index: windowIndex,
          claude_session_id: claudeSessionId,
        },
        'addAgent: claude launched',
      );
    } catch (err) {
      logger.error(
        {
          task_id: task.id,
          agent_id: agentId,
          window_index: windowIndex,
          operation: 'addAgent',
          err,
        },
        'addAgent: failed to launch claude',
      );
      try {
        getDb().prepare(`UPDATE agents SET status = 'stopped' WHERE id = ?`).run(agentId);
      } catch {
        /* DB may be closed in edge cases */
      }
    }
  })().catch(() => {}); // inner try/catch handles all errors; this prevents unhandled rejection

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

  logger.info({ task_id: task.id, operation: 'closeTask' }, 'closeTask: start');

  // Resolve all pending permission prompts for this task
  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE task_id = ? AND status = 'pending'`,
  ).run(task.id);

  // Delete user terminals for this task
  db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);

  // Mark task as closed and all agents as stopped
  db.prepare(`UPDATE tasks SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(
    task.id,
  );
  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ?`,
  ).run(task.id);
  logger.info(
    { task_id: task.id, operation: 'closeTask' },
    'closeTask: DB marked task closed + agents stopped',
  );

  // Kill linked viewer sessions, then main tmux session — worktree and branch are preserved for resume
  if (task.tmux_session) {
    await cleanupLinkedSessions(task.tmux_session);
    try {
      await execFile('tmux', ['kill-session', '-t', task.tmux_session]);
      logger.info(
        { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session },
        'closeTask: tmux session killed',
      );
    } catch (err) {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session },
          'closeTask: tmux session already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session, err },
          'closeTask: tmux kill-session failed',
        );
      }
    }
  }

  logger.info({ task_id: task.id, operation: 'closeTask' }, 'closeTask: complete');
}

export async function deleteTask(task: Task): Promise<void> {
  logger.info(
    { task_id: task.id, operation: 'deleteTask', no_worktree: !!task.no_worktree },
    'deleteTask: start',
  );

  // Kill linked viewer sessions, then main tmux session
  if (task.tmux_session) {
    await cleanupLinkedSessions(task.tmux_session);
    try {
      await execFile('tmux', ['kill-session', '-t', task.tmux_session]);
      logger.info(
        { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session },
        'deleteTask: tmux session killed',
      );
    } catch (err) {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session },
          'deleteTask: tmux session already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session, err },
          'deleteTask: tmux kill-session failed',
        );
      }
    }
  }

  // Skip worktree and branch cleanup for no-worktree tasks
  if (task.no_worktree) {
    logger.info(
      { task_id: task.id, operation: 'deleteTask' },
      'deleteTask: complete (no_worktree mode — skipped worktree/branch cleanup)',
    );
    return;
  }

  // Remove worktree
  if (task.worktree) {
    try {
      await execFile('git', ['-C', task.repo_path, 'worktree', 'remove', task.worktree, '--force']);
      logger.info(
        { task_id: task.id, operation: 'deleteTask', worktree: task.worktree },
        'deleteTask: worktree removed',
      );
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'deleteTask', worktree: task.worktree, err },
        'deleteTask: worktree remove failed (may already be gone)',
      );
    }
  }

  // Delete branch
  if (task.branch) {
    try {
      await execFile('git', ['-C', task.repo_path, 'branch', '-D', task.branch]);
      logger.info(
        { task_id: task.id, operation: 'deleteTask', branch: task.branch },
        'deleteTask: branch deleted',
      );
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'deleteTask', branch: task.branch, err },
        'deleteTask: branch delete failed (may already be gone)',
      );
    }
  }

  logger.info({ task_id: task.id, operation: 'deleteTask' }, 'deleteTask: complete');
}

export async function stopAgent(task: Task, agent: Agent): Promise<void> {
  const db = getDb();

  logger.info(
    {
      task_id: task.id,
      agent_id: agent.id,
      operation: 'stopAgent',
      window_index: agent.window_index,
    },
    'stopAgent: start',
  );

  // Resolve pending permission prompts for this agent
  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE agent_id = ? AND status = 'pending'`,
  ).run(agent.id);

  // Kill the specific tmux window
  await execFile('tmux', ['kill-window', '-t', `${task.tmux_session}:${agent.window_index}`]).catch(
    (err) => {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, agent_id: agent.id, operation: 'stopAgent' },
          'stopAgent: tmux window already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, agent_id: agent.id, operation: 'stopAgent', err },
          'stopAgent: kill-window failed',
        );
      }
    },
  );

  // Mark agent as stopped and idle
  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE id = ?`,
  ).run(agent.id);

  logger.info(
    { task_id: task.id, agent_id: agent.id, operation: 'stopAgent' },
    'stopAgent: complete',
  );
}

export async function createUserTerminal(task: Task): Promise<UserTerminalResult> {
  const settings = await getSettings();
  const editor = settings.editor;

  if (editor === 'vscode' || editor === 'cursor') {
    const cmd = editor === 'vscode' ? 'code' : 'cursor';
    await execFile(cmd, [task.worktree!]);
    return { editor, windowIndex: null };
  }

  // nvim: reuse existing tmux window if already created
  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return { editor, windowIndex: task.user_window_index };
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

  return { editor: 'nvim', windowIndex };
}

export async function createShellTerminal(task: Task): Promise<UserTerminal> {
  const db = getDb();
  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM user_terminals WHERE task_id = ?')
    .get(task.id) as { count: number };
  const label = `Terminal ${count + 1}`;

  const id = nanoid(12);
  db.prepare(
    `INSERT INTO user_terminals (id, task_id, window_index, label) VALUES (?, ?, ?, ?)`,
  ).run(id, task.id, windowIndex, label);

  return {
    id,
    task_id: task.id,
    window_index: windowIndex,
    label,
    status: 'idle',
    created_at: new Date().toISOString(),
  };
}

export async function closeShellTerminal(task: Task, terminal: UserTerminal): Promise<void> {
  const db = getDb();
  await execFile('tmux', [
    'kill-window',
    '-t',
    `${task.tmux_session}:${terminal.window_index}`,
  ]).catch(() => {});
  db.prepare('DELETE FROM user_terminals WHERE id = ?').run(terminal.id);
}

export async function resumeTask(task: Task): Promise<void> {
  const db = getDb();
  const session = task.tmux_session!;

  logger.info(
    { task_id: task.id, operation: 'resumeTask', tmux_session: session, worktree: task.worktree },
    'resumeTask: start',
  );

  try {
    // 1. Set status synchronously to prevent poller race
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', error = NULL, user_window_index = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    // Delete user terminals for this task (fresh start on resume)
    db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);

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

    // Phase 1: Create all tmux windows sequentially (fast, no shell wait)
    const agentTargets: Array<{ agent: Agent; windowIndex: number; target: string }> = [];

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      let windowIndex: number;

      if (i === 0) {
        windowIndex = await getActiveWindowIndex(session);
      } else {
        await execFile('tmux', ['new-window', '-t', session, '-c', task.worktree!]);
        windowIndex = await getLastWindowIndex(session);
      }

      agentTargets.push({
        agent,
        windowIndex,
        target: `${session}:${windowIndex}`,
      });
    }

    // Phase 2: Launch claude in all windows concurrently (slow part — waitForShellReady)
    const flags = await getClaudeFlags();
    await Promise.all(
      agentTargets.map(async ({ agent, windowIndex, target }) => {
        let baseCmd: string;
        if (agent.claude_session_id) {
          baseCmd = `claude --resume ${agent.claude_session_id}${flags}`;
        } else {
          const newSessionId = crypto.randomUUID();
          baseCmd = `claude --continue --session-id ${newSessionId}${flags}`;
          db.prepare('UPDATE agents SET claude_session_id = ? WHERE id = ?').run(
            newSessionId,
            agent.id,
          );
        }

        await sendClaudeCommand({ target, baseCmd });

        db.prepare(`UPDATE agents SET window_index = ?, status = 'running' WHERE id = ?`).run(
          windowIndex,
          agent.id,
        );
        logger.info(
          {
            task_id: task.id,
            agent_id: agent.id,
            operation: 'resumeTask',
            window_index: windowIndex,
            claude_session_id: agent.claude_session_id,
          },
          'resumeTask: agent recovered',
        );
      }),
    );

    // 5. Mark task as running
    db.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    logger.info(
      { task_id: task.id, operation: 'resumeTask', recovered_agents: agents.length },
      'resumeTask: complete',
    );
  } catch (err) {
    logger.error({ task_id: task.id, operation: 'resumeTask', err }, 'resumeTask: failed');
    db.prepare(
      `UPDATE tasks SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run((err as Error).message, task.id);
  }
}
