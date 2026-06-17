import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { getHarness } from './harnesses/index.js';
import { hookBaseUrl } from './hook-base-url.js';
import { getOrCreateRepoConfig } from './repo-config.js';
import { inferRefs } from './ref-inference.js';
import { childLogger } from './logger.js';
import type { RepoConfig } from './repo-config.js';
import type { Task, Agent, UserTerminal, RunMode, Worktree } from './types.js';
import { chatDirFor, chatSessionName } from './chats.js';
import { shellQuoteSingle } from './shell-quote.js';
import { computeMergeBase } from './git-commits.js';

const logger = childLogger('task-runner');

export interface UserTerminalResult {
  editor: 'nvim' | 'vscode' | 'cursor';
  windowIndex: number | null;
}

const execFile = promisify(execFileCb);

/** Root directory for scratch-mode task working dirs. */
export function scratchRoot(): string {
  return path.join(os.homedir(), '.octomux', 'scratch');
}

export function scratchDirFor(taskId: string): string {
  return path.join(scratchRoot(), taskId);
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

/** Delay before removing the on-disk prompt file after launch. Must outlast the
 *  worst-case interactive-shell init: the prompt is read by `cat` as part of the
 *  window's startup command, which only runs after the shell sources its rc
 *  files (can be ~10s on a heavy zsh). 5s was safe when the command was typed
 *  in after a readiness wait; as a startup process the read happens later. */
const PROMPT_FILE_CLEANUP_MS = 60000;

const DISABLED_PLUGINS_IN_WORKTREES = ['remember@claude-plugins-official'] as const;

function writeAgentLocalSettings(worktreePath: string): void {
  const claudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  if (fs.existsSync(settingsPath)) return;
  const plugins: Record<string, boolean> = {};
  for (const p of DISABLED_PLUGINS_IN_WORKTREES) plugins[p] = false;
  fs.writeFileSync(settingsPath, JSON.stringify({ plugins }, null, 2));
}

/**
 * Build the command that launches an agent AS a tmux window's startup process.
 *
 * Running the harness command as the pane's initial process (rather than
 * spawning an interactive shell and typing the command into it with send-keys)
 * removes the shell-readiness race entirely: tmux starts the process when it
 * creates the pane, so there is no prompt to detect, no sentinel handshake, and
 * no possibility of a half-typed or interleaved command. This is the documented
 * fix for the `send-keys`-races-shell-init bug class.
 *
 * The command runs under an interactive shell (`$SHELL -ic`) so it inherits the
 * user's full environment (PATH, nvm, etc.) — exactly what the typed-in command
 * got from the window's default interactive shell before. When the harness
 * exits we `exec $SHELL -i` so the window persists as a usable shell (matching
 * the prior UX). The initial prompt is passed via `"$(cat <file>)"` to keep
 * arbitrary prompt text out of the command line; the file is removed after a
 * delay (see PROMPT_FILE_CLEANUP_MS).
 */
export function buildAgentStartupCommand(args: {
  baseCmd: string;
  prompt?: string | null;
  worktreePath?: string;
  agentId?: string;
}): string {
  let inner = args.baseCmd;
  if (args.prompt && args.worktreePath && args.agentId) {
    const promptFile = path.join(args.worktreePath, `.claude-prompt-${args.agentId}`);
    fs.writeFileSync(promptFile, args.prompt, { mode: 0o600, flag: 'wx' });
    inner += ` "$(cat ${shellQuoteSingle(promptFile)})"`;
    setTimeout(() => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // already removed or never existed
      }
    }, PROMPT_FILE_CLEANUP_MS);
  }
  const shell = process.env.SHELL || '/bin/sh';
  // Keep the window alive as an interactive shell once the harness exits, so
  // the pane stays usable (matches the prior typed-command behaviour).
  const script = `${inner}; exec ${shell} -i`;
  return `${shell} -ic ${shellQuoteSingle(script)}`;
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
 * Kill all linked viewer sessions (`<tmuxSession>-v-*`) for a specific task.
 */
export async function cleanupLinkedSessions(tmuxSession: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('tmux', ['list-sessions', '-F', '#{session_name}']));
  } catch {
    return;
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
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const suffix = id.slice(0, 6);
  return `${slug}-${suffix}`;
}

// ─── Boot-time reconciliation ────────────────────────────────────────────────

/**
 * Sweep setting_up tasks whose tmux session no longer exists. Transition each
 * to status='error' with a clear error message. Intended to run once at boot.
 */
export async function reconcileOrphanSettingUp(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, tmux_session FROM tasks WHERE runtime_state = 'setting_up'`)
    .all() as Array<{ id: string; tmux_session: string | null }>;

  for (const row of rows) {
    let alive = false;
    if (row.tmux_session) {
      try {
        await execFile('tmux', ['has-session', '-t', row.tmux_session]);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      db.prepare(
        `UPDATE tasks SET runtime_state = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run('orphan setting_up on boot', row.id);
      logger.warn(
        { task_id: row.id, operation: 'reconcileOrphanSettingUp' },
        'transitioned orphan setting_up task to error',
      );
    }
  }
}

/**
 * GC scratch dirs that have no matching active task row. A scratch dir is
 * preserved only when a task row with run_mode='scratch' and status in
 * ('draft','setting_up','running') references it.
 */
export async function gcScratchDirs(): Promise<void> {
  const root = scratchRoot();
  if (!fs.existsSync(root)) return;

  const db = getDb();
  const alive = new Set(
    (
      db
        .prepare(
          `SELECT t.id AS id FROM tasks t
             LEFT JOIN worktrees w ON t.worktree_id = w.id
            WHERE w.mode = 'scratch' AND t.runtime_state IN ('idle','setting_up','running')
              AND t.deleted_at IS NULL`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id),
  );

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (alive.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info({ scratch_dir: dir, operation: 'scratch_gc_removed' }, 'scratch_gc_removed');
    } catch (err) {
      logger.warn(
        { scratch_dir: dir, operation: 'scratch_gc_removed', err },
        'scratch_gc_remove_failed',
      );
    }
  }
}

// ─── Per-mode setup helpers ──────────────────────────────────────────────────

async function validateRepo(repoPath: string): Promise<void> {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }
  await execFile('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
}

async function revParseHead(cwd: string, ref = 'HEAD'): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', `${ref}^{commit}`]);
  return stdout.trim();
}

async function checkDirty(repoPath: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['-C', repoPath, 'status', '--porcelain=v1']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface SetupResult {
  worktreePath: string;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  installHooksAt: string;
  runPreflight: boolean;
}

async function setupNew(task: Task): Promise<SetupResult> {
  await validateRepo(task.repo_path);

  const slug = slugifyTitle(task.title, task.id);
  const branch = task.branch || `agents/${slug}`;
  const worktreeDir = task.branch || slug;
  const worktreePath = path.join(task.repo_path, '.worktrees', worktreeDir);

  const worktreeBaseDir = path.join(task.repo_path, '.worktrees');
  fs.mkdirSync(worktreeBaseDir, { recursive: true });

  const worktreeArgs = ['-C', task.repo_path, 'worktree', 'add', worktreePath, '-b', branch];
  if (task.base_branch) worktreeArgs.push(task.base_branch);
  await execFile('git', worktreeArgs);

  // For review tasks, move HEAD to pr_head_sha so the diff UI and merge-base
  // see the PR's actual commit. Auto-review tasks need a fetch first (the SHA
  // may not be a local object yet); manual-review tasks reuse the source
  // task's local HEAD and skip the fetch. Failures here are logged but never
  // abort setup — the agent can recover even with an empty diff.
  if (task.source === 'auto_review' && task.pr_head_sha) {
    if (task.pr_number) {
      try {
        await execFile('git', [
          '-C',
          task.repo_path,
          'fetch',
          'origin',
          `pull/${task.pr_number}/head`,
        ]);
      } catch (err) {
        logger.warn(
          { task_id: task.id, operation: 'createTask', err },
          'createTask: failed to fetch PR head; review may show no files',
        );
      }
    }
    try {
      await execFile('git', ['-C', worktreePath, 'reset', '--hard', task.pr_head_sha]);
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'createTask', err },
        'createTask: failed to reset worktree to pr_head_sha; leaving at base-branch tip',
      );
    }
  }

  const baseRef = task.base_branch || 'HEAD';
  let baseSha: string;
  if (task.source === 'auto_review' && task.pr_head_sha && task.base_branch) {
    try {
      baseSha = await computeMergeBase(task.repo_path, task.base_branch, task.pr_head_sha);
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'createTask', err },
        'createTask: git merge-base failed, falling back to rev-parse',
      );
      baseSha = await revParseHead(task.repo_path, baseRef);
    }
  } else {
    baseSha = await revParseHead(task.repo_path, baseRef);
  }

  // Copy .claude/settings.local.json if it exists
  const settingsSrc = path.join(task.repo_path, '.claude', 'settings.local.json');
  const settingsDst = path.join(worktreePath, '.claude', 'settings.local.json');
  if (fs.existsSync(settingsSrc)) {
    fs.mkdirSync(path.dirname(settingsDst), { recursive: true });
    fs.copyFileSync(settingsSrc, settingsDst);
  }

  writeAgentLocalSettings(worktreePath);
  logger.info(
    {
      task_id: task.id,
      operation: 'createTask',
      settings_path: settingsDst,
      disabled_plugins: DISABLED_PLUGINS_IN_WORKTREES.length,
    },
    'createTask: wrote agent-local settings',
  );

  return {
    worktreePath,
    branch,
    baseBranch: task.base_branch,
    baseSha,
    installHooksAt: worktreePath,
    runPreflight: true,
  };
}

async function setupExisting(task: Task): Promise<SetupResult> {
  const worktreePath = task.worktree;
  if (!worktreePath) {
    throw new Error('existing mode requires a worktree path');
  }
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`existing worktree does not exist: ${worktreePath}`);
  }
  await execFile('git', ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree']);

  const baseSha = await revParseHead(worktreePath);

  let branch: string | null = null;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const name = stdout.trim();
    branch = name === 'HEAD' ? null : name;
  } catch {
    branch = null;
  }

  let baseBranch: string | null = null;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      worktreePath,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const upstream = stdout.trim();
    if (upstream) baseBranch = upstream.replace(/^origin\//, '');
  } catch {
    baseBranch = branch;
  }

  return {
    worktreePath,
    branch,
    baseBranch,
    baseSha,
    installHooksAt: worktreePath,
    runPreflight: false,
  };
}

async function setupNone(task: Task): Promise<SetupResult> {
  await validateRepo(task.repo_path);

  const { stdout: headOut } = await execFile('git', [
    '-C',
    task.repo_path,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const currentBranch = headOut.trim();
  const targetBranch = task.base_branch?.trim() || null;

  if (targetBranch) {
    // Defense in depth: re-run preflight inside setup, in case state changed
    // between the API preflight and now. Exclude self — our own worktree row
    // is already 'setting_up' with w.branch=null (it's only set to targetBranch
    // after setup returns), and the row would otherwise self-conflict.
    const { preflightNoneMode } = await import('./preflight.js');
    const pre = await preflightNoneMode(task.repo_path, targetBranch, task.id);
    if (!pre.ok) {
      const reason = pre.conflicts.length
        ? `another chat is active on a different branch at ${task.repo_path}: ${pre.conflicts
            .map((c) => `${c.task_id} (${c.branch ?? 'unknown'})`)
            .join(', ')}`
        : `working tree at ${task.repo_path} has ${pre.dirty!.count} uncommitted changes`;
      throw new Error(`none mode preflight failed: ${reason}`);
    }
    if (targetBranch !== currentBranch) {
      await execFile('git', ['-C', task.repo_path, 'checkout', targetBranch]);
    }
  } else {
    // Legacy path: no target branch provided, but the tree must still be clean
    // for none mode (preserves existing behavior).
    const dirty = await checkDirty(task.repo_path);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).join(', ');
      const extra = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : '';
      throw new Error(`none mode refuses dirty checkout at ${task.repo_path}: ${preview}${extra}`);
    }
  }

  const finalBranch = targetBranch ?? currentBranch;
  const baseSha = await revParseHead(task.repo_path);

  return {
    worktreePath: task.repo_path,
    branch: finalBranch,
    baseBranch: targetBranch,
    baseSha,
    installHooksAt: task.repo_path,
    runPreflight: false,
  };
}

async function setupScratch(task: Task): Promise<SetupResult> {
  const dir = scratchDirFor(task.id);
  fs.mkdirSync(dir, { recursive: true });

  return {
    worktreePath: dir,
    branch: null,
    baseBranch: null,
    baseSha: null,
    installHooksAt: dir,
    runPreflight: false,
  };
}

// ─── Task lifecycle ──────────────────────────────────────────────────────────

export async function startTask(task: Task): Promise<void> {
  const db = getDb();
  const id = task.id;
  const session = `octomux-agent-${id}`;
  const runMode: RunMode = task.run_mode;

  logger.info(
    { task_id: id, operation: 'createTask', run_mode: runMode, repo_path: task.repo_path },
    'createTask: start',
  );

  let stage = 'validate';
  try {
    stage = 'mode_setup';
    let setup: SetupResult;
    switch (runMode) {
      case 'new':
        setup = await setupNew(task);
        break;
      case 'existing':
        setup = await setupExisting(task);
        break;
      case 'none':
        setup = await setupNone(task);
        break;
      case 'scratch':
        setup = await setupScratch(task);
        break;
      default:
        throw new Error(`unknown run_mode: ${String(runMode)}`);
    }

    // Persist status + setup results, but NOT tmux_session — that column is
    // written after tmux new-session succeeds below. Otherwise pollStatuses
    // can run a has-session check on the not-yet-created session, mark it
    // dead, and stamp error='Setup interrupted' before the session exists.
    // Phase 2a: worktrees is the source of truth. If the task already has a
    // linked worktree row (existing/none/draft-edited), update it. Otherwise
    // create a fresh one.
    db.prepare(
      `UPDATE tasks SET runtime_state = 'setting_up', updated_at = datetime('now') WHERE id = ?`,
    ).run(id);

    const worktreeRepoPath = runMode === 'scratch' ? null : task.repo_path;
    if (task.worktree_id) {
      db.prepare(
        `UPDATE worktrees
            SET path = ?, repo_path = ?, branch = ?, base_branch = ?, base_sha = ?,
                mode = ?, status = 'in_use', last_used_at = datetime('now')
          WHERE id = ?`,
      ).run(
        setup.worktreePath,
        worktreeRepoPath,
        setup.branch,
        setup.baseBranch,
        setup.baseSha,
        runMode,
        task.worktree_id,
      );
    } else {
      const worktreeId = nanoid(12);
      db.prepare(
        `INSERT INTO worktrees
           (id, path, repo_path, branch, base_branch, base_sha, mode, status, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_use', datetime('now'))`,
      ).run(
        worktreeId,
        setup.worktreePath,
        worktreeRepoPath,
        setup.branch,
        setup.baseBranch,
        setup.baseSha,
        runMode,
      );
      db.prepare(`UPDATE tasks SET worktree_id = ? WHERE id = ?`).run(worktreeId, id);
    }

    logger.info(
      {
        task_id: id,
        operation: 'createTask',
        run_mode: runMode,
        branch: setup.branch,
        worktree: setup.worktreePath,
        base_sha: setup.baseSha,
      },
      'createTask: setup complete',
    );

    // ─── Branch-name ref inference ────────────────────────────────────────
    // Run inference before preflight so refs are available when hooks fire.
    if (setup.branch && task.repo_path) {
      try {
        const repoConfigForInference = await getOrCreateRepoConfig(task.repo_path);
        const inferred = inferRefs(setup.branch, repoConfigForInference, id);
        if (inferred.length > 0) {
          const insertRef = db.prepare(
            `INSERT OR IGNORE INTO task_external_refs (task_id, integration, ref, url, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
          );
          for (const ref of inferred) {
            insertRef.run(id, ref.integration, ref.ref, ref.url);
            logger.info(
              { task_id: id, integration: ref.integration, ref: ref.ref },
              'ref-inference: inferred ref from branch name',
            );
          }
        }
      } catch (err) {
        // Never block task startup for ref-inference failures
        logger.warn({ task_id: id, err }, 'ref-inference: error during inference');
      }
    }

    if (setup.runPreflight) {
      stage = 'preflight';
      const repoConfig = await getOrCreateRepoConfig(task.repo_path);
      await preflightWorktree(setup.worktreePath, repoConfig);
    }

    stage = 'launch_agent';
    const harness = getHarness(task.harness_id);
    const agentId = nanoid(12);
    const agentName = task.agent ?? null;
    const hookToken = crypto.randomBytes(32).toString('hex');
    const flags = harness.resolveFlags(await getSettings());

    let sessionIdForDb: string | null;
    let sessionIdForLaunch: string;
    if (harness.sessionIdMode === 'orchestrator-assigned') {
      const sid = harness.newSessionId();
      sessionIdForDb = sid;
      sessionIdForLaunch = sid;
    } else {
      sessionIdForDb = null;
      sessionIdForLaunch = harness.newSessionId();
    }

    // Hooks must be on disk BEFORE the window launches the harness — with the
    // launch-as-startup-command model the harness starts the instant the pane
    // is created, so there is no readiness wait to install them during.
    await harness.syncAgents(setup.worktreePath);
    await harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken);

    const baseCmd = harness.buildLaunchCommand({
      sessionId: sessionIdForLaunch,
      agent: agentName,
      flags,
      model: (task as any).model ?? null,
      workspacePath: setup.worktreePath,
    });
    const startupCmd = buildAgentStartupCommand({
      baseCmd,
      prompt: task.initial_prompt,
      worktreePath: setup.worktreePath,
      agentId,
    });

    stage = 'tmux_session';
    // Launch the harness as the session's first window's startup process: tmux
    // starts it when it creates the pane, so there is no shell-readiness race.
    await execFile('tmux', [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      setup.worktreePath,
      startupCmd,
    ]);
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

    const windowIndex = await getActiveWindowIndex(session);
    db.prepare(
      `INSERT INTO agents
         (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, id, windowIndex, 'Agent 1', harness.id, sessionIdForDb, hookToken, agentName);

    // Fire-and-forget: harness-specific post-launch (e.g. Cursor trust prompt).
    void harness.postLaunch?.(`${session}:${windowIndex}`);
    logger.info(
      {
        task_id: id,
        agent_id: agentId,
        operation: 'createTask',
        window_index: windowIndex,
        harness: harness.id,
        harness_session_id: sessionIdForDb,
      },
      'createTask: first agent launched',
    );

    // Mark as running. Clear error too — a transient error value (e.g.
    // stamped by the poller during a pre-fix race, or a prior failed setup
    // attempt) would otherwise linger on a successfully running task.
    // Also flip workflow_status to in_progress when starting from backlog/planned.
    db.prepare(
      `UPDATE tasks SET runtime_state = 'running', error = NULL,
       workflow_status = CASE
         WHEN workflow_status IN ('backlog', 'planned') THEN 'in_progress'
         ELSE workflow_status
       END,
       updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
    logger.info({ task_id: id, operation: 'createTask' }, 'createTask: complete');
  } catch (err) {
    logger.error(
      { task_id: id, operation: 'createTask', stage, run_mode: runMode, err },
      'createTask: failed during setup stage',
    );
    db.prepare(
      `UPDATE tasks SET runtime_state = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run((err as Error).message, id);
  }
}

export interface AddAgentOpts {
  prompt?: string;
  agent?: string | null;
  label?: string;
  model?: string | null;
  skeleton?: string;
  notify_agent_id?: string | null;
}

export async function addAgent(task: Task, opts: AddAgentOpts = {}): Promise<Agent> {
  const db = getDb();

  const resolvedAgent = opts.agent ?? null;

  logger.info({ task_id: task.id, operation: 'addAgent', agent: resolvedAgent }, 'addAgent: start');

  const activeAgents = db
    .prepare(`SELECT * FROM agents WHERE task_id = ? AND status != 'stopped' ORDER BY window_index`)
    .all(task.id) as Agent[];
  const label = opts.label ?? `Agent ${activeAgents.length + 1}`;

  const harness = getHarness(task.harness_id);
  const agentId = nanoid(12);
  // All agents in one task share a single worktree settings.local.json, so
  // they must share one hook_token. Reuse the existing token from any agent
  // in the task; only mint a new one if none exist (shouldn't happen since
  // createTask always seeds Agent 1).
  const existingTokenRow = db
    .prepare(`SELECT hook_token FROM agents WHERE task_id = ? AND hook_token != '' LIMIT 1`)
    .get(task.id) as { hook_token: string } | undefined;
  const hookToken = existingTokenRow?.hook_token ?? crypto.randomBytes(32).toString('hex');
  const flags = harness.resolveFlags(await getSettings());

  let resolvedPrompt = opts.prompt;
  if (opts.skeleton) {
    const skeletonPath = path.join(task.worktree!, '.octomux', 'agents', `${opts.skeleton}.md`);
    if (!fs.existsSync(skeletonPath)) {
      throw new Error(`skeleton not found: ${opts.skeleton} (expected at ${skeletonPath})`);
    }
    const skeletonContent = fs.readFileSync(skeletonPath, 'utf-8') as string;
    resolvedPrompt = opts.prompt
      ? `${skeletonContent}\n\n# Task\n\n${opts.prompt}`
      : skeletonContent;
  }

  let sessionIdForDb: string | null;
  let sessionIdForLaunch: string;
  if (harness.sessionIdMode === 'orchestrator-assigned') {
    const sid = harness.newSessionId();
    sessionIdForDb = sid;
    sessionIdForLaunch = sid;
  } else {
    sessionIdForDb = null;
    sessionIdForLaunch = harness.newSessionId();
  }

  // Hooks on disk before the window launches the harness (starts on pane create).
  await harness.syncAgents(task.worktree!);
  await harness.installHooks(task.worktree!, hookBaseUrl(), hookToken);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: resolvedAgent,
    flags,
    model: opts.model ?? (task as any).model ?? null,
    workspacePath: task.worktree!,
  });
  const startupCmd = buildAgentStartupCommand({
    baseCmd,
    prompt: resolvedPrompt,
    worktreePath: task.worktree!,
    agentId,
  });

  // Launch as the new window's startup process — no shell-readiness race.
  await execFile('tmux', [
    'new-window',
    '-t',
    task.tmux_session!,
    '-c',
    task.worktree!,
    startupCmd,
  ]);
  const windowIndex = await getLastWindowIndex(task.tmux_session!);
  const addTarget = `${task.tmux_session}:${windowIndex}`;

  db.prepare(
    `INSERT INTO agents
       (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent, notify_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    task.id,
    windowIndex,
    label,
    harness.id,
    sessionIdForDb,
    hookToken,
    resolvedAgent,
    opts.notify_agent_id ?? null,
  );

  void harness.postLaunch?.(addTarget);
  logger.info(
    {
      task_id: task.id,
      agent_id: agentId,
      operation: 'addAgent',
      window_index: windowIndex,
      harness: harness.id,
      harness_session_id: sessionIdForDb,
    },
    'addAgent: claude launched',
  );

  return {
    id: agentId,
    task_id: task.id,
    window_index: windowIndex,
    label,
    status: 'running',
    harness_id: harness.id,
    harness_session_id: sessionIdForDb,
    hook_token: hookToken,
    hook_activity: 'active' as const,
    hook_activity_updated_at: null,
    tmux_session: null,
    agent: resolvedAgent,
    created_at: new Date().toISOString(),
  };
}

export async function closeTask(task: Task): Promise<void> {
  const db = getDb();

  logger.info(
    { task_id: task.id, operation: 'closeTask', run_mode: task.run_mode },
    'closeTask: start',
  );

  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE task_id = ? AND status = 'pending'`,
  ).run(task.id);

  db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);

  db.prepare(
    `UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
  ).run(task.id);
  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ?`,
  ).run(task.id);
  // Release the worktree so Phase 2b Workspaces can show it as available.
  db.prepare(
    `UPDATE worktrees SET status = 'available', last_used_at = datetime('now')
      WHERE id = (SELECT worktree_id FROM tasks WHERE id = ?)`,
  ).run(task.id);
  logger.info(
    { task_id: task.id, operation: 'closeTask' },
    'closeTask: DB marked task closed + agents stopped',
  );

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

/**
 * Soft-delete a task: kill tmux + flag for the purge poller. Keeps worktree,
 * branch, and all DB rows so the user can restore from the trash column
 * within the grace window. The purge poller calls `deleteTask` on rows past
 * grace.
 */
export async function softDeleteTask(task: Task): Promise<void> {
  const db = getDb();
  logger.info({ task_id: task.id, operation: 'softDeleteTask' }, 'softDeleteTask: start');

  if (task.tmux_session) {
    await cleanupLinkedSessions(task.tmux_session);
    try {
      await execFile('tmux', ['kill-session', '-t', task.tmux_session]);
    } catch (err) {
      if (!isTmuxTargetMissing(err)) {
        logger.warn(
          { task_id: task.id, tmux_session: task.tmux_session, err },
          'softDeleteTask: tmux kill-session failed',
        );
      }
    }
  }

  db.prepare(
    `UPDATE tasks SET deleted_at = datetime('now'),
                      runtime_state = 'idle',
                      updated_at = datetime('now')
       WHERE id = ?`,
  ).run(task.id);

  db.prepare(
    `UPDATE agents
        SET status = 'stopped',
            hook_activity = 'idle',
            hook_activity_updated_at = datetime('now')
      WHERE task_id = ? AND status = 'running'`,
  ).run(task.id);

  logger.info({ task_id: task.id, operation: 'softDeleteTask' }, 'softDeleteTask: complete');
}

export async function deleteTask(task: Task): Promise<void> {
  const db = getDb();
  logger.info(
    { task_id: task.id, operation: 'deleteTask', run_mode: task.run_mode },
    'deleteTask: start',
  );

  // Kill tmux first — applies to every mode
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

  switch (task.run_mode) {
    case 'new': {
      if (task.worktree) {
        try {
          await execFile('git', [
            '-C',
            task.repo_path,
            'worktree',
            'remove',
            task.worktree,
            '--force',
          ]);
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
      break;
    }
    case 'existing':
    case 'none':
      // Intentionally do nothing — user's worktree/repo must never be touched.
      logger.info(
        { task_id: task.id, operation: 'deleteTask', run_mode: task.run_mode },
        'deleteTask: skipped filesystem cleanup (user-owned path)',
      );
      break;
    case 'scratch': {
      const dir = task.worktree || scratchDirFor(task.id);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info(
          { task_id: task.id, operation: 'deleteTask', scratch_dir: dir },
          'deleteTask: scratch dir removed',
        );
      } catch (err) {
        logger.warn(
          { task_id: task.id, operation: 'deleteTask', scratch_dir: dir, err },
          'deleteTask: scratch dir remove failed (may already be gone)',
        );
      }
      break;
    }
  }

  // Worktree row fate: `new`/`scratch` own the filesystem, so their row goes
  // away with the task. `existing`/`none` belong to the user — keep the row
  // so Phase 2b Workspaces still sees it.
  //
  // FK ordering: tasks.worktree_id references worktrees.id. Unlink the task
  // from the worktree row before deleting the row, else the FK check fires.
  const wtId = task.worktree_id;
  if (wtId) {
    db.prepare(`UPDATE tasks SET worktree_id = NULL WHERE id = ?`).run(task.id);
    if (task.run_mode === 'new' || task.run_mode === 'scratch') {
      db.prepare(`DELETE FROM worktrees WHERE id = ?`).run(wtId);
    } else {
      db.prepare(
        `UPDATE worktrees SET status = 'available', last_used_at = datetime('now') WHERE id = ?`,
      ).run(wtId);
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

  db.prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE agent_id = ? AND status = 'pending'`,
  ).run(agent.id);

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
  const runMode: RunMode = task.run_mode;

  logger.info(
    {
      task_id: task.id,
      operation: 'resumeTask',
      run_mode: runMode,
      tmux_session: session,
      worktree: task.worktree,
    },
    'resumeTask: start',
  );

  try {
    // Mode-specific pre-resume validation
    if (runMode === 'existing') {
      if (!task.worktree || !fs.existsSync(task.worktree)) {
        throw new Error(`existing worktree no longer exists: ${task.worktree ?? '<null>'}`);
      }
    } else if (runMode === 'scratch') {
      if (!task.worktree || !fs.existsSync(task.worktree)) {
        throw new Error(`scratch dir no longer exists: ${task.worktree ?? '<null>'}`);
      }
    } else if (runMode === 'none') {
      if (!fs.existsSync(task.repo_path)) {
        throw new Error(`repo_path no longer exists: ${task.repo_path}`);
      }
      const dirty = await checkDirty(task.repo_path);
      if (dirty.length > 0) {
        const preview = dirty.slice(0, 5).join(', ');
        const extra = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : '';
        throw new Error(
          `none mode refuses dirty checkout at ${task.repo_path}: ${preview}${extra}`,
        );
      }
    }

    db.prepare(
      `UPDATE tasks SET runtime_state = 'setting_up', error = NULL, user_window_index = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);

    await cleanupLinkedSessions(session);
    await execFile('tmux', ['kill-session', '-t', session]).catch(() => {});

    // Killing the tmux session means every agent on this task is, by
    // definition, no longer running. Reconcile the DB before we read it back —
    // on the Mac-restart recovery path the poller hasn't yet flipped agents
    // from 'running' to 'stopped', so without this they'd be filtered out
    // below and we'd create the new tmux session with no claude in it.
    db.prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now') WHERE task_id = ? AND status != 'stopped'`,
    ).run(task.id);

    const cwd = task.worktree!;

    const agents = db
      .prepare(
        `SELECT * FROM agents WHERE task_id = ? AND status = 'stopped' ORDER BY window_index`,
      )
      .all(task.id) as Agent[];

    // Install hooks once, before any window launches its harness — each window
    // starts its harness the instant the pane is created (launch-as-startup),
    // so there is no readiness wait during which to install them.
    if (agents.length > 0) {
      const bootstrapHarness = getHarness(agents[0]!.harness_id);
      await bootstrapHarness.syncAgents(cwd);
      await bootstrapHarness.installHooks(cwd, hookBaseUrl(), agents[0]!.hook_token);
    } else {
      // No agents to recover, but recreate the session so callers that expect
      // the task's tmux session to exist after resume still find it.
      await execFile('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
      await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);
    }

    let sessionCreated = false;
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      const harness = getHarness(agent.harness_id);
      const flags = harness.resolveFlags(await getSettings());

      const taskModel = (task as any).model ?? null;
      let baseCmd: string;
      if (agent.harness_session_id) {
        baseCmd = harness.buildResumeCommand({
          sessionId: agent.harness_session_id,
          flags,
          model: taskModel,
          workspacePath: cwd,
        });
      } else {
        const newId = harness.newSessionId();
        const continueCmd = harness.buildContinueCommand({
          sessionId: newId,
          flags,
          model: taskModel,
          workspacePath: cwd,
        });
        if (continueCmd !== null) {
          baseCmd = continueCmd;
        } else {
          baseCmd = harness.buildLaunchCommand({
            sessionId: newId,
            agent: agent.agent,
            flags,
            model: taskModel,
            workspacePath: cwd,
          });
          logger.warn(
            { agent_id: agent.id, harness: harness.id },
            'continue unsupported, launching fresh',
          );
        }
        if (harness.sessionIdMode === 'orchestrator-assigned') {
          db.prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(newId, agent.id);
        }
      }

      // Resume/continue carries no initial prompt; launch as the window's
      // startup process so there is no shell-readiness race.
      const startupCmd = buildAgentStartupCommand({ baseCmd });
      let windowIndex: number;
      if (!sessionCreated) {
        await execFile('tmux', ['new-session', '-d', '-s', session, '-c', cwd, startupCmd]);
        await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);
        sessionCreated = true;
        windowIndex = await getActiveWindowIndex(session);
      } else {
        await execFile('tmux', ['new-window', '-t', session, '-c', cwd, startupCmd]);
        windowIndex = await getLastWindowIndex(session);
      }
      void harness.postLaunch?.(`${session}:${windowIndex}`);

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
          harness: harness.id,
          harness_session_id: agent.harness_session_id,
        },
        'resumeTask: agent recovered',
      );
    }

    db.prepare(
      `UPDATE tasks SET runtime_state = 'running', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);

    logger.info(
      { task_id: task.id, operation: 'resumeTask', recovered_agents: agents.length },
      'resumeTask: complete',
    );
  } catch (err) {
    logger.error({ task_id: task.id, operation: 'resumeTask', err }, 'resumeTask: failed');
    db.prepare(
      `UPDATE tasks SET runtime_state = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run((err as Error).message, task.id);
  }
}

// ─── Agent task-hopping ──────────────────────────────────────────────────────

/**
 * Move `agent` to a different task (or detach it to a standalone chat when
 * `targetTaskId` is null). Kills the old tmux window, creates a new one at the
 * new cwd, and resumes with `claude --resume` so transcript context survives.
 */
export async function hopAgent(agent: Agent, targetTaskId: string | null): Promise<Agent> {
  const db = getDb();
  const fromTaskId = agent.task_id;
  logger.info(
    {
      agent_id: agent.id,
      from_task_id: fromTaskId,
      to_task_id: targetTaskId,
      operation: 'task_hop',
    },
    'task_hop: start',
  );

  // Resolve old tmux target for the kill step.
  let oldTarget: { session: string; window: number } | null = null;
  if (agent.task_id) {
    const prevTask = db
      .prepare(`SELECT tmux_session FROM tasks WHERE id = ?`)
      .get(agent.task_id) as { tmux_session: string | null } | undefined;
    if (prevTask?.tmux_session) {
      oldTarget = { session: prevTask.tmux_session, window: agent.window_index };
    }
  } else if (agent.tmux_session) {
    // Standalone chat agents have their own session.
    oldTarget = { session: agent.tmux_session, window: agent.window_index };
  }

  // Resolve new destination.
  let newSession: string;
  let cwd: string;
  let isStandalone: boolean;
  if (targetTaskId === null) {
    // Detach → standalone chat.
    isStandalone = true;
    newSession = chatSessionName(agent.id);
    cwd = chatDirFor(agent.id);
    fs.mkdirSync(cwd, { recursive: true });
  } else {
    isStandalone = false;
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(targetTaskId) as
      | { id: string; tmux_session: string | null; worktree_id: string | null; status: string }
      | undefined;
    if (!task) throw new Error(`Task not found: ${targetTaskId}`);
    if (!task.worktree_id) throw new Error(`Task ${targetTaskId} has no worktree`);
    const worktree = db.prepare(`SELECT * FROM worktrees WHERE id = ?`).get(task.worktree_id) as
      | Worktree
      | undefined;
    if (!worktree) throw new Error(`Worktree not found for task ${targetTaskId}`);
    if (!worktree.path || !fs.existsSync(worktree.path)) {
      throw new Error(`Worktree path does not exist: ${worktree.path}`);
    }
    if (!task.tmux_session) {
      throw new Error(`Task ${targetTaskId} has no tmux session (not running)`);
    }
    newSession = task.tmux_session;
    cwd = worktree.path;
  }

  // Kill the old window. For a standalone chat agent, kill the entire session
  // (it belongs to this agent only).
  if (oldTarget) {
    try {
      if (!agent.task_id && agent.tmux_session) {
        await execFile('tmux', ['kill-session', '-t', agent.tmux_session]);
      } else {
        await execFile('tmux', ['kill-window', '-t', `${oldTarget.session}:${oldTarget.window}`]);
      }
    } catch (err) {
      if (!isTmuxTargetMissing(err)) {
        logger.warn(
          { agent_id: agent.id, operation: 'task_hop', err },
          'task_hop: kill old tmux target failed',
        );
      }
    }
  }

  const harness = getHarness(agent.harness_id);
  const flags = harness.resolveFlags(await getSettings());

  // Inherit model from the target task (if hopping to a task).
  let hopModel: string | null = null;
  if (targetTaskId) {
    const hopTask = db.prepare(`SELECT model FROM tasks WHERE id = ?`).get(targetTaskId) as
      | { model: string | null }
      | undefined;
    hopModel = hopTask?.model ?? null;
  }

  // Hooks on disk before the window launches the harness (starts on pane create).
  await harness.syncAgents(cwd);
  await harness.installHooks(cwd, hookBaseUrl(), agent.hook_token);

  let baseCmd: string;
  if (agent.harness_session_id) {
    baseCmd = harness.buildResumeCommand({
      sessionId: agent.harness_session_id,
      flags,
      model: hopModel,
      workspacePath: cwd,
    });
  } else {
    const newId = harness.newSessionId();
    const continueCmd = harness.buildContinueCommand({
      sessionId: newId,
      flags,
      model: hopModel,
      workspacePath: cwd,
    });
    if (continueCmd !== null) {
      baseCmd = continueCmd;
    } else {
      baseCmd = harness.buildLaunchCommand({
        sessionId: newId,
        agent: agent.agent,
        flags,
        model: hopModel,
        workspacePath: cwd,
      });
      logger.warn(
        { agent_id: agent.id, harness: harness.id },
        'continue unsupported, launching fresh',
      );
    }
    if (harness.sessionIdMode === 'orchestrator-assigned') {
      db.prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(newId, agent.id);
    }
  }

  // Create the new tmux destination, launching the harness as the window's
  // startup process so there is no shell-readiness race.
  const startupCmd = buildAgentStartupCommand({ baseCmd });
  let newWindowIndex: number;
  if (isStandalone) {
    await execFile('tmux', ['new-session', '-d', '-s', newSession, '-c', cwd, startupCmd]);
    await execFile('tmux', ['set-option', '-t', newSession, 'aggressive-resize', 'on']);
    newWindowIndex = await getActiveWindowIndex(newSession);
  } else {
    await execFile('tmux', ['new-window', '-t', newSession, '-c', cwd, startupCmd]);
    newWindowIndex = await getLastWindowIndex(newSession);
  }
  const target = `${newSession}:${newWindowIndex}`;
  void harness.postLaunch?.(target);

  // Update DB row. For standalone agents we persist tmux_session; for
  // task-scoped ones we read the session via the task join.
  db.prepare(
    `UPDATE agents
        SET task_id = ?, window_index = ?, tmux_session = ?, status = 'running',
            hook_activity = 'active', hook_activity_updated_at = datetime('now')
      WHERE id = ?`,
  ).run(targetTaskId, newWindowIndex, isStandalone ? newSession : null, agent.id);

  logger.info(
    {
      agent_id: agent.id,
      from_task_id: fromTaskId,
      to_task_id: targetTaskId,
      new_window_index: newWindowIndex,
      new_tmux_session: newSession,
      operation: 'task_hop',
    },
    'task_hop: complete',
  );

  return db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agent.id) as Agent;
}
