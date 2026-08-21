import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { childLogger } from '../../logger.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import { chatDirFor, chatSessionName } from '../../chats.js';
import { sessionFor, localSession } from '../../compute/index.js';
import type { Worker, Worktree, Task } from '../../types.js';
import {
  getTask as getTaskRepo,
  getWorktree,
  hopAgentToTask,
  getWorker,
} from '../../repositories/index.js';
import { buildAgentStartupCommand, launchAgentWindow, prepareResumeLaunch } from '../launch.js';
import { isTmuxTargetMissing } from '../sessions.js';

const logger = childLogger('task-engine/lifecycle');

/**
 * Hop moves an agent's tmux window from wherever it is now to a different
 * task (or to a standalone chat session). It is NOT a live migration of the
 * running process — it kills the old window and launches a fresh one
 * (resumed/continued via `prepareResumeLaunch` when the harness supports it).
 *
 * That distinction matters once tasks can live on different compute
 * providers: a harness resume/continue depends on session state (transcript
 * files, auth) that lives on whichever machine the PREVIOUS window ran on.
 * Hopping to a task on a *different* compute provider would silently start
 * a same-looking-but-actually-blank session there, so it is refused below
 * rather than allowed to quietly do the wrong thing. A standalone chat
 * target is always local (chats are out of scope for the compute seam), so
 * hopping FROM a non-local task TO a chat is refused for the same reason.
 */
export async function hopAgent(agent: Worker, targetTaskId: string | null): Promise<Worker> {
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

  const sourceTask = fromTaskId ? getTaskRepo(fromTaskId) : null;
  const sourceCompute = sourceTask ? await sessionFor(sourceTask) : localSession;

  let oldTarget: { session: string; window: number } | null = null;
  if (fromTaskId && sourceTask?.tmux_session) {
    oldTarget = { session: sourceTask.tmux_session, window: agent.window_index };
  } else if (!fromTaskId && agent.tmux_session) {
    oldTarget = { session: agent.tmux_session, window: agent.window_index };
  }

  let newSession: string;
  let cwd: string;
  let isStandalone: boolean;
  let destTask: Task | null = null;
  let destCompute = localSession;
  if (targetTaskId === null) {
    isStandalone = true;
    newSession = chatSessionName(agent.id);
    cwd = chatDirFor(agent.id);
    // Standalone chats stay on the server's own machine (out of scope for
    // the compute seam), so this is always localSession, not sourceCompute.
    await localSession.files.mkdirp(cwd);
  } else {
    isStandalone = false;
    const task = getTaskRepo(targetTaskId);
    if (!task) throw new Error(`Task not found: ${targetTaskId}`);
    destTask = task;
    destCompute = await sessionFor(task);
    if (!task.worktree_id) throw new Error(`Task ${targetTaskId} has no worktree`);
    const worktree = getWorktree(task.worktree_id) as Worktree | undefined;
    if (!worktree) throw new Error(`Worktree not found for task ${targetTaskId}`);
    if (!worktree.path || !(await destCompute.files.exists(worktree.path))) {
      throw new Error(`Worktree path does not exist: ${worktree.path}`);
    }
    if (!task.tmux_session) {
      throw new Error(`Task ${targetTaskId} has no tmux session (not running)`);
    }
    newSession = task.tmux_session;
    cwd = worktree.path;
  }

  if (sourceCompute.kind !== destCompute.kind) {
    throw new Error(
      `task_hop: cannot hop agent ${agent.id} from compute "${sourceCompute.kind}" to ` +
        `"${destCompute.kind}" — harness session state (transcripts, auth) lives on the ` +
        `source machine and does not transfer. Hop within the same compute provider.`,
    );
  }

  if (oldTarget) {
    try {
      if (!agent.task_id && agent.tmux_session) {
        await sourceCompute.tmux(['kill-session', '-t', agent.tmux_session]);
      } else {
        await sourceCompute.tmux(['kill-window', '-t', `${oldTarget.session}:${oldTarget.window}`]);
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

  const hopModel: string | null = destTask?.model ?? null;

  const flags = await resolveHarnessFlags(harness, {
    skillContentOverrides: await skillContentOverridesForScheduleId(destTask?.schedule_id),
  });

  await harness.installHooks(cwd, hookBaseUrl(), agent.hook_token, destCompute.files);

  const baseCmd = prepareResumeLaunch({ agent, harness, flags, model: hopModel, cwd });
  const startupCmd = await buildAgentStartupCommand(destCompute, { baseCmd });
  const newWindowIndex = await launchAgentWindow(destCompute, {
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

  return getWorker(agent.id) as Worker;
}
