import { broadcast } from '../events.js';
import { execTmux } from '../tmux-bin.js';
import { sendMessageToAgent } from '../tmux-input.js';
import {
  listRunningTasks,
  setRuntimeStateIdle,
  setRuntimeStateSetupInterrupted,
  getParentTaskTmuxSession,
} from '../repositories/tasks.js';
import {
  stopRunningAgentsForTask,
  findFirstActiveAgent,
  listWatchedAgents,
  stopAgent,
  getNotifyAgentTarget,
} from '../repositories/agent-runtime.js';
import { completeTeamRunByLeadTask } from '../repositories/team-schedules.js';
import type { Task } from '../types.js';
import { pollTerminalActivity } from './terminal-activity.js';

async function notifyParentTask(parentTaskId: string, finishedTask: Task): Promise<void> {
  const parent = getParentTaskTmuxSession(parentTaskId);
  if (!parent?.tmux_session) return;

  const agent = findFirstActiveAgent(parentTaskId);
  if (!agent) return;

  const msg = `[octomux] Worker task ${finishedTask.id} ("${finishedTask.title}") finished. Check results: octomux get-task --json ${finishedTask.id}`;
  await sendMessageToAgent(parent.tmux_session, agent.window_index, msg);
}

export async function checkTaskStatus(task: Task): Promise<'alive' | 'dead'> {
  if (!task.tmux_session) return 'dead';
  try {
    await execTmux(['has-session', '-t', task.tmux_session]);
    return 'alive';
  } catch {
    return 'dead';
  }
}

async function checkWindowStatus(session: string, windowIndex: number): Promise<'alive' | 'dead'> {
  try {
    await execTmux(['display-message', '-t', `${session}:${windowIndex}`, '-p', '#I']);
    return 'alive';
  } catch {
    return 'dead';
  }
}

async function pollAgentWindows(): Promise<void> {
  const watchedAgents = listWatchedAgents();

  const results = await Promise.allSettled(
    watchedAgents.map(async (agent) => {
      const status = await checkWindowStatus(agent.tmux_session, agent.window_index);
      return { agent, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { agent, status } = result.value;
    if (status !== 'dead') continue;

    stopAgent(agent.id);

    const target = getNotifyAgentTarget(agent.notify_agent_id);
    if (!target) continue;

    const msg = `[octomux] Sub-agent ${agent.id} ("${agent.label}") finished. Check results: octomux get-task --json ${agent.task_id}`;
    await sendMessageToAgent(target.tmux_session, target.window_index, msg);
  }
}

export async function pollStatuses(): Promise<void> {
  const runningTasks = listRunningTasks();

  const results = await Promise.allSettled(
    runningTasks.map(async (task) => {
      const status = await checkTaskStatus(task);
      return { task, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { task, status } = result.value;
    if (status !== 'dead') continue;

    const rs = task.runtime_state;
    // 'looping' tasks are exempt: respawnAgentFresh briefly swaps tmux windows
    // (new window up, then old one killed), which can make has-session look
    // dead for an instant. Tearing the task down on that gap would kill the loop.
    if (rs === 'looping') continue;
    if (rs === 'running') {
      setRuntimeStateIdle(task.id);
    } else if (rs === 'setting_up') {
      setRuntimeStateSetupInterrupted(task.id);
    } else {
      continue;
    }
    completeTeamRunByLeadTask(task.id);
    stopRunningAgentsForTask(task.id);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });

    if (task.notify_task_id) {
      notifyParentTask(task.notify_task_id, task).catch(() => {});
    }
  }

  await pollTerminalActivity();
  await pollAgentWindows();
}
