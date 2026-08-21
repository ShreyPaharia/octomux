import { broadcast } from '../events.js';
import { sessionFor } from '../compute/index.js';
import { sendMessageToAgent } from '../tmux-input.js';
import {
  listRunningTasks,
  setRuntimeStateIdle,
  setRuntimeStateSetupInterrupted,
  getParentTaskTmuxSession,
  getTask,
} from '../repositories/tasks.js';
import {
  stopRunningAgentsForTask,
  findFirstActiveAgent,
  listWatchedAgents,
  stopAgent,
  getNotifyAgentTarget,
} from '../repositories/workers.js';
import type { Task } from '../types.js';
import { pollTerminalActivity } from './terminal-activity.js';

async function notifyParentTask(parentTaskId: string, finishedTask: Task): Promise<void> {
  const parent = getParentTaskTmuxSession(parentTaskId);
  if (!parent?.tmux_session) return;

  const agent = findFirstActiveAgent(parentTaskId);
  if (!agent) return;

  const parentTask = getTask(parentTaskId);
  if (!parentTask) return;

  const msg = `[octomux] Worker task ${finishedTask.id} ("${finishedTask.title}") finished. Check results: octomux get-task --json ${finishedTask.id}`;
  await sendMessageToAgent(
    await sessionFor(parentTask),
    parent.tmux_session,
    agent.window_index,
    msg,
  );
}

export async function checkTaskStatus(task: Task): Promise<'alive' | 'dead'> {
  if (!task.tmux_session) return 'dead';
  try {
    const compute = await sessionFor(task);
    await compute.tmux(['has-session', '-t', task.tmux_session]);
    return 'alive';
  } catch {
    return 'dead';
  }
}

async function checkWindowStatus(
  task: Task,
  session: string,
  windowIndex: number,
): Promise<'alive' | 'dead'> {
  try {
    const compute = await sessionFor(task);
    await compute.tmux(['display-message', '-t', `${session}:${windowIndex}`, '-p', '#I']);
    return 'alive';
  } catch {
    return 'dead';
  }
}

async function pollAgentWindows(): Promise<void> {
  const watchedAgents = listWatchedAgents();

  const results = await Promise.allSettled(
    watchedAgents.map(async (agent) => {
      // `listWatchedAgents` joins in the tmux session but not a full Task —
      // rehydrate so the probe hits the agent's own compute, not the local
      // machine. One indexed getTask() per watched agent on a poller tick;
      // watched-agent counts are tiny (sub-agent notify targets), so the
      // N+1 here is cheap and correct beats silently local-only.
      const task = getTask(agent.task_id);
      const status = task
        ? await checkWindowStatus(task, agent.tmux_session, agent.window_index)
        : 'dead';
      return { agent, task, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { agent, status } = result.value;
    if (status !== 'dead') continue;

    stopAgent(agent.id);

    const target = getNotifyAgentTarget(agent.notify_agent_id);
    if (!target) continue;

    // The notify target lives in its own task, not necessarily the finishing
    // worker's — hydrate and use ITS compute for the tmux send.
    const targetTask = getTask(target.task_id);
    if (!targetTask) continue;

    const msg = `[octomux] Sub-agent ${agent.id} ("${agent.label}") finished. Check results: octomux get-task --json ${agent.task_id}`;
    await sendMessageToAgent(
      await sessionFor(targetTask),
      target.tmux_session,
      target.window_index,
      msg,
    );
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
    stopRunningAgentsForTask(task.id);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });

    if (task.notify_task_id) {
      notifyParentTask(task.notify_task_id, task).catch(() => {});
    }
  }

  await pollTerminalActivity();
  await pollAgentWindows();
}
