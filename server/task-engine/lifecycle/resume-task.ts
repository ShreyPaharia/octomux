import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { childLogger } from '../../logger.js';
import { tmuxWindowSubstrate } from '../../agent-session/substrate-tmux-windowed.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import { sessionFor } from '../../compute/index.js';
import type { ComputeSession } from '../../compute/types.js';
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
import { enforcePolicy } from '../../plugins/policy.js';

const logger = childLogger('task-engine/lifecycle');

/** Mode-specific pre-resume validation (existing/scratch/none). */
export async function validateResumeTask(c: ComputeSession, task: Task): Promise<void> {
  const runMode: RunMode = task.run_mode;

  if (runMode === 'existing') {
    if (!task.worktree || !(await c.files.exists(task.worktree))) {
      throw new Error(`existing worktree no longer exists: ${task.worktree ?? '<null>'}`);
    }
  } else if (runMode === 'scratch') {
    if (!task.worktree || !(await c.files.exists(task.worktree))) {
      throw new Error(`scratch dir no longer exists: ${task.worktree ?? '<null>'}`);
    }
  } else if (runMode === 'none') {
    if (!(await c.files.exists(task.repo_path))) {
      throw new Error(`repo_path no longer exists: ${task.repo_path}`);
    }
    const dirty = await checkDirty(c, task.repo_path);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).join(', ');
      const extra = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : '';
      throw new Error(`none mode refuses dirty checkout at ${task.repo_path}: ${preview}${extra}`);
    }
  }
}

/** Reset task state and tear down the old tmux session before recovery. */
export async function prepareResumeSession(
  c: ComputeSession,
  task: Task,
  session: string,
): Promise<void> {
  updateTaskFields(task.id, {
    runtime_state: 'setting_up',
    error: null,
    user_window_index: null,
  });

  deleteUserTerminalsByTask(task.id);
  await cleanupLinkedSessions(c, session);
  await c.tmux(['kill-session', '-t', session]).catch(() => {});
  stopRunningAgents(task.id);
}

/** Install hooks once before relaunching stopped agents (or create an empty session). */
export async function bootstrapResumeHooks(
  c: ComputeSession,
  task: Task,
  cwd: string,
  session: string,
): Promise<void> {
  const agents = listStoppedAgents(task.id);

  if (agents.length > 0) {
    const bootstrapHarness = getHarness(agents[0]!.harness_id);
    await bootstrapHarness.installHooks(cwd, hookBaseUrl(), agents[0]!.hook_token, c.files);
  } else {
    await tmuxWindowSubstrate.createEmptySession(c, { session, cwd });
  }
}

/** Relaunch each stopped agent window and mark the task running. Returns count recovered. */
export async function relaunchStoppedAgents(
  c: ComputeSession,
  task: Task,
  session: string,
  cwd: string,
  prompt?: string,
  modelOverride?: string | null,
): Promise<number> {
  const agents = listStoppedAgents(task.id);
  let sessionCreated = false;

  for (const agent of agents) {
    const harness = getHarness(agent.harness_id);
    const flags = await resolveHarnessFlags(harness, {
      skillContentOverrides: await skillContentOverridesForScheduleId(
        (task as { schedule_id?: string | null }).schedule_id,
      ),
    });
    const taskModel = modelOverride !== undefined ? modelOverride : ((task as any).model ?? null);
    const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: taskModel, cwd });
    // Deliver the resume prompt through the first agent's startup command
    // (positional arg) — race-free, unlike send-keys against a booting TUI.
    const withPrompt = !sessionCreated && !!prompt;
    const startupCmd = await buildAgentStartupCommand(c, {
      baseCmd,
      prompt: withPrompt ? prompt : undefined,
      worktreePath: withPrompt ? cwd : undefined,
      agentId: withPrompt ? agent.id : undefined,
      harness,
    });
    const windowIndex = await launchAgentWindow(c, {
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

export async function resumeTask(task: Task, opts?: { prompt?: string }): Promise<void> {
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
    // Gates only the resume verb. `respawn-agent.ts` (fresh agent, loop iterations)
    // and `add-agent.ts` (new window on a running task) are different verbs — they
    // propagate errors straight to their HTTP/loop callers rather than through
    // `tasks.error`, so they are not wired to this gate here.
    const originalModel = (task as any).model ?? null;
    const decided = await enforcePolicy('harness.resume', {
      taskId: task.id,
      repoPath: task.repo_path,
      data: { harnessId: task.harness_id, model: originalModel, prompt: opts?.prompt ?? null },
    });
    const modelOverride = typeof decided.model === 'string' ? decided.model : originalModel;

    const compute = await sessionFor(task);
    await validateResumeTask(compute, task);
    await prepareResumeSession(compute, task, session);
    const cwd = task.worktree!;
    await bootstrapResumeHooks(compute, task, cwd, session);
    const recoveredAgents = await relaunchStoppedAgents(
      compute,
      task,
      session,
      cwd,
      opts?.prompt,
      modelOverride,
    );

    logger.info(
      { task_id: task.id, operation: 'resumeTask', recovered_agents: recoveredAgents },
      'resumeTask: complete',
    );
  } catch (err) {
    logger.error({ task_id: task.id, operation: 'resumeTask', err }, 'resumeTask: failed');
    setRuntimeState(task.id, 'error', (err as Error).message);
  }
}
