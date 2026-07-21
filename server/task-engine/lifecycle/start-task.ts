import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { getSettings } from '../../settings.js';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { getOrCreateRepoConfig } from '../../repositories/repo-config.js';
import { inferRefs } from '../../ref-inference.js';
import { childLogger } from '../../logger.js';
import { broadcast } from '../../events.js';
import { syncSkills } from '../../skills.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import type { RepoConfig } from '../../repositories/repo-config.js';
import type { Task, RunMode } from '../../types.js';
import {
  setRuntimeState,
  setWorktreeId,
  setTmuxSession,
  markTaskRunning,
  insertTaskExternalRefIfAbsent,
  updateWorktreeOnSetup,
  insertWorktreeInUse,
  insertAgent as insertAgentRepo,
} from '../../repositories/index.js';
import {
  buildAgentStartupCommand,
  launchAgentWindow,
  computeFreshSessionIds,
  applyOrchestratorMcpConfig,
} from '../launch.js';
import { runSetup } from '../setup/index.js';

const logger = childLogger('task-engine/lifecycle');
const execFile = promisify(execFileCb);

export async function preflightWorktree(worktreePath: string, config: RepoConfig): Promise<void> {
  try {
    await execFile('sh', ['-c', config.format_command], { cwd: worktreePath });
  } catch {
    // Non-critical: repo may not have this script
  }

  try {
    await execFile('sh', ['-c', config.lint_command], { cwd: worktreePath });
  } catch {
    // Non-critical
  }

  const { stdout: diff } = await execFile('git', ['diff', '--name-only'], { cwd: worktreePath });
  if (diff.trim()) {
    await execFile('git', ['add', '-A'], { cwd: worktreePath });
    await execFile('git', ['commit', '-m', 'chore: fix pre-existing formatting'], {
      cwd: worktreePath,
    });
  }
}

function persistWorktreeRow(
  id: string,
  task: Task,
  setup: import('../setup/types.js').SetupResult,
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

async function inferAndPersistRefs(
  id: string,
  setup: import('../setup/types.js').SetupResult,
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
    logger.warn({ task_id: id, err }, 'ref-inference: error during inference');
  }
}

async function runPreflight(
  setup: import('../setup/types.js').SetupResult,
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

async function prepareFirstAgentLaunch(
  id: string,
  task: Task,
  setup: import('../setup/types.js').SetupResult,
  harness: import('../../harnesses/index.js').Harness,
): Promise<FirstAgentLaunchParams> {
  const agentId = nanoid(12);
  const agentName = task.agent ?? null;
  const hookToken = crypto.randomBytes(32).toString('hex');
  let flags = harness.resolveFlags(await getSettings());

  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await harness.syncAgents(setup.worktreePath);
  const skillContentOverrides = await skillContentOverridesForScheduleId(
    (task as { schedule_id?: string | null }).schedule_id,
  );
  await syncSkills(setup.worktreePath, { skillContentOverrides });
  await harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken);

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

async function launchFirstWindow(
  id: string,
  session: string,
  setup: import('../setup/types.js').SetupResult,
  startupCmd: string,
): Promise<number> {
  const windowIndex = await launchAgentWindow({
    session,
    cwd: setup.worktreePath,
    startupCmd,
    fresh: true,
  });
  setTmuxSession(id, session);
  logger.info(
    { task_id: id, operation: 'createTask', tmux_session: session },
    'createTask: tmux session created',
  );
  return windowIndex;
}

function persistFirstAgentRow(
  id: string,
  agentId: string,
  task: Task,
  harness: import('../../harnesses/index.js').Harness,
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

    markTaskRunning(id);
    logger.info({ task_id: id, operation: 'createTask' }, 'createTask: complete');
  } catch (err) {
    logger.error(
      { task_id: id, operation: 'createTask', stage, run_mode: runMode, err },
      'createTask: failed during setup stage',
    );
    setRuntimeState(id, 'error', (err as Error).message);
    broadcast({ type: 'task:updated', payload: { taskId: id } });
  }
}
