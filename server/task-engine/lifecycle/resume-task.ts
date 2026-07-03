import fs from 'fs';
import { getSettings } from '../../settings.js';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { childLogger } from '../../logger.js';
import { tmuxWindowSubstrate } from '../../agent-session/substrate-tmux-windowed.js';
import { execTmux } from '../../tmux-bin.js';
import { syncSkills } from '../../skills.js';
import type { Task, RunMode } from '../../types.js';
import {
  setRuntimeState,
  updateTaskFields,
  listStoppedAgents,
  deleteUserTerminalsByTask,
  setAgentWindowRunning,
  stopRunningAgents,
} from '../../repositories/index.js';
import { buildAgentStartupCommand, launchAgentWindow, prepareResumeLaunch } from '../launch.js';
import { cleanupLinkedSessions } from '../sessions.js';
import { checkDirty } from '../git.js';

const logger = childLogger('task-engine/lifecycle');

/** Mode-specific pre-resume validation (existing/scratch/none). */
export async function validateResumeTask(task: Task): Promise<void> {
  const runMode: RunMode = task.run_mode;

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
      throw new Error(`none mode refuses dirty checkout at ${task.repo_path}: ${preview}${extra}`);
    }
  }
}

/** Reset task state and tear down the old tmux session before recovery. */
export async function prepareResumeSession(task: Task, session: string): Promise<void> {
  updateTaskFields(task.id, {
    runtime_state: 'setting_up',
    error: null,
    user_window_index: null,
  });

  deleteUserTerminalsByTask(task.id);
  await cleanupLinkedSessions(session);
  await execTmux(['kill-session', '-t', session]).catch(() => {});
  stopRunningAgents(task.id);
}

/** Install hooks once before relaunching stopped agents (or create an empty session). */
export async function bootstrapResumeHooks(
  task: Task,
  cwd: string,
  session: string,
): Promise<void> {
  const agents = listStoppedAgents(task.id);

  if (agents.length > 0) {
    const bootstrapHarness = getHarness(agents[0]!.harness_id);
    await bootstrapHarness.syncAgents(cwd);
    await syncSkills(cwd);
    await bootstrapHarness.installHooks(cwd, hookBaseUrl(), agents[0]!.hook_token);
  } else {
    await tmuxWindowSubstrate.createEmptySession({ session, cwd });
  }
}

/** Relaunch each stopped agent window and mark the task running. Returns count recovered. */
export async function relaunchStoppedAgents(
  task: Task,
  session: string,
  cwd: string,
): Promise<number> {
  const agents = listStoppedAgents(task.id);
  let sessionCreated = false;

  for (const agent of agents) {
    const harness = getHarness(agent.harness_id);
    const flags = harness.resolveFlags(await getSettings());
    const taskModel = (task as any).model ?? null;
    const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: taskModel, cwd });
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
  return agents.length;
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
    await validateResumeTask(task);
    await prepareResumeSession(task, session);
    const cwd = task.worktree!;
    await bootstrapResumeHooks(task, cwd, session);
    const recoveredAgents = await relaunchStoppedAgents(task, session, cwd);

    logger.info(
      { task_id: task.id, operation: 'resumeTask', recovered_agents: recoveredAgents },
      'resumeTask: complete',
    );
  } catch (err) {
    logger.error({ task_id: task.id, operation: 'resumeTask', err }, 'resumeTask: failed');
    setRuntimeState(task.id, 'error', (err as Error).message);
  }
}
