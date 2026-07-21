import fs from 'fs';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { childLogger } from '../../logger.js';
import { execTmux } from '../../tmux-bin.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import { chatDirFor, chatSessionName } from '../../chats.js';
import type { Agent, Worktree } from '../../types.js';
import {
  getTask as getTaskRepo,
  getTaskTmuxSession,
  getWorktree,
  hopAgentToTask,
  getAgent,
} from '../../repositories/index.js';
import { buildAgentStartupCommand, launchAgentWindow, prepareResumeLaunch } from '../launch.js';
import { isTmuxTargetMissing } from '../sessions.js';

const logger = childLogger('task-engine/lifecycle');

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

  let oldTarget: { session: string; window: number } | null = null;
  if (agent.task_id) {
    const prevTask = getTaskTmuxSession(agent.task_id);
    if (prevTask?.tmux_session) {
      oldTarget = { session: prevTask.tmux_session, window: agent.window_index };
    }
  } else if (agent.tmux_session) {
    oldTarget = { session: agent.tmux_session, window: agent.window_index };
  }

  let newSession: string;
  let cwd: string;
  let isStandalone: boolean;
  if (targetTaskId === null) {
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

  let hopModel: string | null = null;
  const hopTask = targetTaskId ? getTaskRepo(targetTaskId) : null;
  if (hopTask) {
    hopModel = hopTask.model ?? null;
  }

  const flags = await resolveHarnessFlags(harness, {
    skillContentOverrides: await skillContentOverridesForScheduleId(
      (hopTask as { schedule_id?: string | null } | null)?.schedule_id,
    ),
  });


  await harness.installHooks(cwd, hookBaseUrl(), agent.hook_token);

  const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: hopModel, cwd });
  const startupCmd = buildAgentStartupCommand({ baseCmd });
  const newWindowIndex = await launchAgentWindow({
    session: newSession,
    cwd,
    startupCmd,
    fresh: isStandalone,
  });
  const target = `${newSession}:${newWindowIndex}`;
  void harness.postLaunch?.(target);

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
