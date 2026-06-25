import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getSettings } from '../settings.js';
import { getHarness } from '../harnesses/index.js';
import { hookBaseUrl } from '../hook-base-url.js';
import { getOrCreateRepoConfig } from '../repositories/repo-config.js';
import { inferRefs } from '../ref-inference.js';
import { childLogger } from '../logger.js';
import { execTmux } from '../tmux-bin.js';
import { broadcast } from '../events.js';
import type { RepoConfig } from '../repositories/repo-config.js';
import type { Task, Agent, RunMode, Worktree } from '../types.js';
import { chatDirFor, chatSessionName } from '../chats.js';
import { syncSkills } from '../skills.js';
import {
  setRuntimeState,
  updateTaskFields,
  setWorktreeId,
  setTmuxSession,
  markTaskRunning,
  insertTaskExternalRefIfAbsent,
  getTask as getTaskRepo,
  getTaskTmuxSession,
  getTaskModel,
  updateWorktreeOnSetup,
  insertWorktreeInUse,
  getWorktree,
  insertAgent as insertAgentRepo,
  insertAgentWithNotify,
  listActiveAgents,
  listStoppedAgents,
  getTaskHookToken,
  setAgentWindowRunning,
  stopRunningAgents,
  getAgent,
  hopAgentToTask,
  deleteUserTerminalsByTask,
} from '../repositories/index.js';
import {
  buildAgentStartupCommand,
  launchAgentWindow,
  computeFreshSessionIds,
  applyOrchestratorMcpConfig,
  prepareResumeLaunch,
} from './launch.js';
import { runSetup } from './setup/index.js';
import { cleanupLinkedSessions, isTmuxTargetMissing } from './sessions.js';
import { checkDirty } from './git.js';

const logger = childLogger('task-engine/lifecycle');

const execFile = promisify(execFileCb);

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

// ─── startTask step functions (module-private) ───────────────────────────────

/**
 * Flip the task to setting_up and persist the worktree row.
 *
 * Writes runtime_state='setting_up' first (so the UI reflects progress), then
 * either updates the existing worktree row (existing/none/draft-edited modes) or
 * inserts a fresh one and links it to the task. Does NOT touch tmux_session —
 * that column is written only after the tmux session is confirmed to exist (see
 * launchFirstWindow) to prevent the poller from racing a has-session check on a
 * not-yet-created session and stamping 'Setup interrupted'.
 */
function persistWorktreeRow(
  id: string,
  task: Task,
  setup: import('./setup/types.js').SetupResult,
  runMode: RunMode,
): void {
  setRuntimeState(id, 'setting_up');

  const worktreeRepoPath = runMode === 'scratch' ? null : task.repo_path;
  if (task.worktree_id) {
    updateWorktreeOnSetup(task.worktree_id, {
      path: setup.worktreePath,
      repo_path: worktreeRepoPath,
      branch: setup.branch,
      base_branch: setup.baseBranch,
      base_sha: setup.baseSha,
      mode: runMode,
    });
  } else {
    const worktreeId = insertWorktreeInUse({
      path: setup.worktreePath,
      repo_path: worktreeRepoPath,
      branch: setup.branch,
      base_branch: setup.baseBranch,
      base_sha: setup.baseSha,
      mode: runMode,
    });
    setWorktreeId(id, worktreeId);
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
}

/**
 * Infer external refs from the branch name and persist any new ones.
 *
 * Runs before preflight so refs are available when hooks fire. Failures are
 * swallowed — ref inference must never block task startup.
 */
async function inferAndPersistRefs(
  id: string,
  setup: import('./setup/types.js').SetupResult,
  task: Task,
): Promise<void> {
  if (!setup.branch || !task.repo_path) return;
  try {
    const repoConfigForInference = await getOrCreateRepoConfig(task.repo_path);
    const inferred = inferRefs(setup.branch, repoConfigForInference, id);
    for (const ref of inferred) {
      insertTaskExternalRefIfAbsent({
        task_id: id,
        integration: ref.integration,
        ref: ref.ref,
        url: ref.url,
      });
      logger.info(
        { task_id: id, integration: ref.integration, ref: ref.ref },
        'ref-inference: inferred ref from branch name',
      );
    }
  } catch (err) {
    // Never block task startup for ref-inference failures
    logger.warn({ task_id: id, err }, 'ref-inference: error during inference');
  }
}

/**
 * Run preflight formatting/lint auto-fix in the worktree (gated by setup flag).
 */
async function runPreflight(
  setup: import('./setup/types.js').SetupResult,
  task: Task,
): Promise<void> {
  if (!setup.runPreflight) return;
  const repoConfig = await getOrCreateRepoConfig(task.repo_path);
  await preflightWorktree(setup.worktreePath, repoConfig);
}

interface FirstAgentLaunchParams {
  agentId: string;
  hookToken: string;
  sessionIdForDb: string | null;
  startupCmd: string;
}

/**
 * Compute session IDs, install hooks, apply orchestrator MCP config, and build
 * the harness startup command for the first agent of a new task.
 *
 * Hooks must be on disk BEFORE the window launches the harness — with the
 * launch-as-startup-command model the harness starts the instant the pane is
 * created, so there is no readiness wait during which to install them.
 */
async function prepareFirstAgentLaunch(
  id: string,
  task: Task,
  setup: import('./setup/types.js').SetupResult,
  harness: import('../harnesses/index.js').Harness,
): Promise<FirstAgentLaunchParams> {
  const agentId = nanoid(12);
  const agentName = task.agent ?? null;
  const hookToken = crypto.randomBytes(32).toString('hex');
  let flags = harness.resolveFlags(await getSettings());

  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await harness.syncAgents(setup.worktreePath);
  await syncSkills(setup.worktreePath);
  await harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken);

  // For orchestrator-managed tasks, write a worker mcp-config.json and append
  // --mcp-config to the launch flags so the worker gets the report_complete tool.
  // Do NOT use --strict-mcp-config (worker keeps its normal tools + user MCP servers).
  // managed_tasks is registered before startTask runs (runCreateTask → upsertManagedTask).
  flags = applyOrchestratorMcpConfig(flags, setup.worktreePath, id, hookToken);

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

  return { agentId, hookToken, sessionIdForDb, startupCmd };
}

/**
 * Create the tmux session with the harness as the first window's startup
 * process, then persist tmux_session to the DB.
 *
 * setTmuxSession is called AFTER launchAgentWindow returns so the column is
 * only written once the session is confirmed to exist (race-avoidance invariant).
 */
async function launchFirstWindow(
  id: string,
  session: string,
  setup: import('./setup/types.js').SetupResult,
  startupCmd: string,
): Promise<number> {
  // Launch the harness as the session's first window's startup process: tmux
  // starts it when it creates the pane, so there is no shell-readiness race.
  const windowIndex = await launchAgentWindow({
    session,
    cwd: setup.worktreePath,
    startupCmd,
    fresh: true,
  });
  // Session exists now — persist the column. See race-avoidance comment above.
  setTmuxSession(id, session);
  logger.info(
    { task_id: id, operation: 'createTask', tmux_session: session },
    'createTask: tmux session created',
  );
  return windowIndex;
}

/**
 * Insert the agent DB row, fire the harness post-launch hook, and log completion.
 */
function persistFirstAgentRow(
  id: string,
  agentId: string,
  task: Task,
  harness: import('../harnesses/index.js').Harness,
  windowIndex: number,
  sessionIdForDb: string | null,
  hookToken: string,
  session: string,
): void {
  insertAgentRepo({
    id: agentId,
    task_id: id,
    window_index: windowIndex,
    label: 'Agent 1',
    harness_id: harness.id,
    harness_session_id: sessionIdForDb,
    hook_token: hookToken,
    agent: task.agent ?? null,
  });

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
}

// ─── Task lifecycle ──────────────────────────────────────────────────────────

export async function startTask(task: Task): Promise<void> {
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
    const setup = await runSetup(task);

    persistWorktreeRow(id, task, setup, runMode);

    // ─── Branch-name ref inference ────────────────────────────────────────
    // Run inference before preflight so refs are available when hooks fire.
    await inferAndPersistRefs(id, setup, task);

    if (setup.runPreflight) {
      stage = 'preflight';
    }
    await runPreflight(setup, task);

    stage = 'launch_agent';
    const harness = getHarness(task.harness_id);
    const { agentId, hookToken, sessionIdForDb, startupCmd } = await prepareFirstAgentLaunch(
      id,
      task,
      setup,
      harness,
    );

    stage = 'tmux_session';
    const windowIndex = await launchFirstWindow(id, session, setup, startupCmd);

    persistFirstAgentRow(
      id,
      agentId,
      task,
      harness,
      windowIndex,
      sessionIdForDb,
      hookToken,
      session,
    );

    // Mark as running. Clear error too — a transient error value (e.g.
    // stamped by the poller during a pre-fix race, or a prior failed setup
    // attempt) would otherwise linger on a successfully running task.
    // Also flip workflow_status to in_progress when starting from backlog/planned.
    markTaskRunning(id);
    logger.info({ task_id: id, operation: 'createTask' }, 'createTask: complete');
  } catch (err) {
    logger.error(
      { task_id: id, operation: 'createTask', stage, run_mode: runMode, err },
      'createTask: failed during setup stage',
    );
    setRuntimeState(id, 'error', (err as Error).message);
    // Surface the failure: the orchestrator supervisor relays it to the owning
    // conversation so the conductor (and user) learn the task errored instead of
    // silently sitting in an error state.
    broadcast({ type: 'task:updated', payload: { taskId: id } });
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
  const resolvedAgent = opts.agent ?? null;

  logger.info({ task_id: task.id, operation: 'addAgent', agent: resolvedAgent }, 'addAgent: start');

  const activeAgents = listActiveAgents(task.id);
  const label = opts.label ?? `Agent ${activeAgents.length + 1}`;

  const harness = getHarness(task.harness_id);
  const agentId = nanoid(12);
  // All agents in one task share a single worktree settings.local.json, so
  // they must share one hook_token. Reuse the existing token from any agent
  // in the task; only mint a new one if none exist (shouldn't happen since
  // createTask always seeds Agent 1).
  const existingTokenRow = getTaskHookToken(task.id);
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

  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  // Hooks on disk before the window launches the harness (starts on pane create).
  await harness.syncAgents(task.worktree!);
  await syncSkills(task.worktree!);
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
  const windowIndex = await launchAgentWindow({
    session: task.tmux_session!,
    cwd: task.worktree!,
    startupCmd,
    fresh: false,
  });
  const addTarget = `${task.tmux_session}:${windowIndex}`;

  insertAgentWithNotify({
    id: agentId,
    task_id: task.id,
    window_index: windowIndex,
    label,
    harness_id: harness.id,
    harness_session_id: sessionIdForDb,
    hook_token: hookToken,
    agent: resolvedAgent,
    notify_agent_id: opts.notify_agent_id ?? null,
  });

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
    notify_agent_id: opts.notify_agent_id ?? null,
    created_at: new Date().toISOString(),
  };
}

export async function resumeTask(task: Task): Promise<void> {
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

    updateTaskFields(task.id, {
      runtime_state: 'setting_up',
      error: null,
      user_window_index: null,
    });

    deleteUserTerminalsByTask(task.id);

    await cleanupLinkedSessions(session);
    await execTmux(['kill-session', '-t', session]).catch(() => {});

    // Killing the tmux session means every agent on this task is, by
    // definition, no longer running. Reconcile the DB before we read it back —
    // on the Mac-restart recovery path the poller hasn't yet flipped agents
    // from 'running' to 'stopped', so without this they'd be filtered out
    // below and we'd create the new tmux session with no claude in it.
    stopRunningAgents(task.id);

    const cwd = task.worktree!;

    const agents = listStoppedAgents(task.id);

    // Install hooks once, before any window launches its harness — each window
    // starts its harness the instant the pane is created (launch-as-startup),
    // so there is no readiness wait during which to install them.
    if (agents.length > 0) {
      const bootstrapHarness = getHarness(agents[0]!.harness_id);
      await bootstrapHarness.syncAgents(cwd);
      await syncSkills(cwd);
      await bootstrapHarness.installHooks(cwd, hookBaseUrl(), agents[0]!.hook_token);
    } else {
      // No agents to recover, but recreate the session so callers that expect
      // the task's tmux session to exist after resume still find it.
      await execTmux(['new-session', '-d', '-s', session, '-c', cwd]);
      await execTmux(['set-option', '-t', session, 'aggressive-resize', 'on']);
    }

    let sessionCreated = false;
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]!;
      const harness = getHarness(agent.harness_id);
      const flags = harness.resolveFlags(await getSettings());

      const taskModel = (task as any).model ?? null;
      const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: taskModel, cwd });

      // Resume/continue carries no initial prompt; launch as the window's
      // startup process so there is no shell-readiness race.
      const startupCmd = buildAgentStartupCommand({ baseCmd });
      const windowIndex = await launchAgentWindow({
        session,
        cwd,
        startupCmd,
        fresh: !sessionCreated,
      });
      sessionCreated = true;
      void harness.postLaunch?.(`${session}:${windowIndex}`);

      setAgentWindowRunning(agent.id, windowIndex);
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

    setRuntimeState(task.id, 'running');

    logger.info(
      { task_id: task.id, operation: 'resumeTask', recovered_agents: agents.length },
      'resumeTask: complete',
    );
  } catch (err) {
    logger.error({ task_id: task.id, operation: 'resumeTask', err }, 'resumeTask: failed');
    setRuntimeState(task.id, 'error', (err as Error).message);
  }
}

// ─── Agent task-hopping ──────────────────────────────────────────────────────

/**
 * Move `agent` to a different task (or detach it to a standalone chat when
 * `targetTaskId` is null). Kills the old tmux window, creates a new one at the
 * new cwd, and resumes with `claude --resume` so transcript context survives.
 */
export async function hopAgent(agent: Agent, targetTaskId: string | null): Promise<Agent> {
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
    const prevTask = getTaskTmuxSession(agent.task_id);
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
    const task = getTaskRepo(targetTaskId!);
    if (!task) throw new Error(`Task not found: ${targetTaskId}`);
    if (!task.worktree_id) throw new Error(`Task ${targetTaskId} has no worktree`);
    const worktree = getWorktree(task.worktree_id) as Worktree | undefined;
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
        await execTmux(['kill-session', '-t', agent.tmux_session]);
      } else {
        await execTmux(['kill-window', '-t', `${oldTarget.session}:${oldTarget.window}`]);
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
    const hopTask = getTaskModel(targetTaskId);
    hopModel = hopTask?.model ?? null;
  }

  // Hooks on disk before the window launches the harness (starts on pane create).
  await harness.syncAgents(cwd);
  await syncSkills(cwd);
  await harness.installHooks(cwd, hookBaseUrl(), agent.hook_token);

  const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: hopModel, cwd });

  // Create the new tmux destination, launching the harness as the window's
  // startup process so there is no shell-readiness race.
  const startupCmd = buildAgentStartupCommand({ baseCmd });
  const newWindowIndex = await launchAgentWindow({
    session: newSession,
    cwd,
    startupCmd,
    fresh: isStandalone,
  });
  const target = `${newSession}:${newWindowIndex}`;
  void harness.postLaunch?.(target);

  // Update DB row. For standalone agents we persist tmux_session; for
  // task-scoped ones we read the session via the task join.
  hopAgentToTask(agent.id, targetTaskId, newWindowIndex, isStandalone ? newSession : null);

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

  return getAgent(agent.id) as Agent;
}
