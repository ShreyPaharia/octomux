import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { getOrCreateRepoConfig } from '../../repositories/repo-config.js';
import { inferRefs } from '../../ref-inference.js';
import { childLogger } from '../../logger.js';
import { broadcast } from '../../events.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
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
import { enforcePolicy } from '../../plugins/policy.js';

const logger = childLogger('task-engine/lifecycle');

// Note: repo_configs.format_command and lint_command columns still exist in the DB
// but are no longer used during new-task setup. The format/lint preflight was removed
// (perf: it blocked agent launch for 30-90s with no agent-observable benefit).

/** Time a startTask stage and log `duration_ms` so slow creates are greppable
 *  (`grep '"stage_timing":true' ~/.octomux/logs/octomux.log`). Also what
 *  `scripts/bench-task-create.ts` reads to produce its breakdown. */
async function timed<T>(taskId: string, stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    logger.info(
      {
        task_id: taskId,
        operation: 'createTask',
        stage,
        stage_timing: true,
        duration_ms: Math.round(performance.now() - t0),
      },
      `createTask: stage ${stage}`,
    );
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
  modelOverride: string | null,
): Promise<FirstAgentLaunchParams> {
  const agentId = nanoid(12);
  const agentName = task.agent ?? null;
  const hookToken = crypto.randomBytes(32).toString('hex');
  let flags = await resolveHarnessFlags(harness, {
    skillContentOverrides: await skillContentOverridesForScheduleId(
      (task as { schedule_id?: string | null }).schedule_id,
    ),
  });

  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await timed(id, 'install_hooks', () =>
    harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken),
  );

  flags = applyOrchestratorMcpConfig(flags, setup.worktreePath, id, hookToken);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: agentName,
    flags,
    model: modelOverride,
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

  let stage = 'policy';
  try {
    const originalModel = (task as any).model ?? null;
    const decided = await enforcePolicy('task.launch', {
      taskId: id,
      repoPath: task.repo_path,
      data: { harnessId: task.harness_id, model: originalModel, agent: task.agent ?? null },
    });
    const modelOverride = typeof decided.model === 'string' ? decided.model : originalModel;
    if (modelOverride !== originalModel) {
      logger.info(
        { task_id: id, operation: 'policy', from: originalModel, to: modelOverride },
        'createTask: policy patched model',
      );
    }

    stage = 'mode_setup';
    const setup = await timed(id, 'mode_setup', () => runSetup(task));

    persistWorktreeRow(id, task, setup, runMode);
    await timed(id, 'infer_refs', () => inferAndPersistRefs(id, setup, task));

    stage = 'launch_agent';
    const harness = getHarness(task.harness_id);
    const { agentId, hookToken, sessionIdForDb, startupCmd } = await timed(id, 'launch_agent', () =>
      prepareFirstAgentLaunch(id, task, setup, harness, modelOverride),
    );

    stage = 'tmux_session';
    const windowIndex = await timed(id, 'tmux_session', () =>
      launchFirstWindow(id, session, setup, startupCmd),
    );

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
