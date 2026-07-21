import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import { childLogger } from '../../logger.js';
import { broadcast } from '../../events.js';
import { execTmux } from '../../tmux-bin.js';
import {
  getAgent,
  setAgentWindowRunning,
  setAgentHarnessSessionId,
} from '../../repositories/index.js';
import { buildAgentStartupCommand, launchAgentWindow, computeFreshSessionIds } from '../launch.js';
import { isTmuxTargetMissing } from '../sessions.js';
import type { Agent, Task } from '../../types.js';

const logger = childLogger('task-engine/lifecycle');

/**
 * Respawn an agent with a FRESH context: new tmux window, new harness session
 * (no --resume), in the task's EXISTING tmux session. The new window is
 * created (and its index confirmed via tmux) before the old one is killed, so
 * the session never drops to zero windows — which would otherwise destroy it.
 *
 * `opts.prompt` seeds the fresh session's first turn (a fresh session has no
 * memory of prior turns). `opts.env` is exported into the new window's shell
 * — used by the loop harness to carry OCTOMUX_ACTION_TOKEN/BASE_URL so the
 * agent's `octomux emit` CLI call can authenticate.
 *
 * `opts.fresh` (default false): the task's tmux session died along with it
 * (e.g. server restart) — create a brand-new session instead of a window in
 * the (nonexistent) old one, and skip killing the old window since there's
 * nothing left to kill.
 */
export async function respawnAgentFresh(
  task: Task,
  agent: Agent,
  opts?: { prompt?: string; env?: Record<string, string>; fresh?: boolean },
): Promise<Agent> {
  logger.info(
    { task_id: task.id, agent_id: agent.id, operation: 'respawn_fresh' },
    'respawn_fresh: start',
  );

  const harness = getHarness(agent.harness_id);
  const flags = await resolveHarnessFlags(harness, {
    skillContentOverrides: await skillContentOverridesForScheduleId(
      (task as { schedule_id?: string | null }).schedule_id,
    ),
  });
  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);


  await harness.installHooks(task.worktree!, hookBaseUrl(), agent.hook_token);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: agent.agent,
    flags,
    model: (task as { model?: string | null }).model ?? null,
    workspacePath: task.worktree!,
  });
  const startupCmd = buildAgentStartupCommand({
    baseCmd,
    prompt: opts?.prompt,
    worktreePath: opts?.prompt ? task.worktree! : undefined,
    agentId: opts?.prompt ? agent.id : undefined,
    env: opts?.env,
  });

  const fresh = opts?.fresh ?? false;
  const oldWindowIndex = agent.window_index;
  const newWindowIndex = await launchAgentWindow({
    session: task.tmux_session!,
    cwd: task.worktree!,
    startupCmd,
    fresh,
  });

  setAgentWindowRunning(agent.id, newWindowIndex);
  if (harness.sessionIdMode === 'orchestrator-assigned' && sessionIdForDb) {
    setAgentHarnessSessionId(agent.id, sessionIdForDb);
  }

  const target = `${task.tmux_session}:${newWindowIndex}`;
  void harness.postLaunch?.(target);

  if (!fresh) {
    await execTmux(['kill-window', '-t', `${task.tmux_session}:${oldWindowIndex}`]).catch((err) => {
      if (!isTmuxTargetMissing(err)) {
        logger.warn(
          { task_id: task.id, agent_id: agent.id, operation: 'respawn_fresh', err },
          'respawn_fresh: kill old window failed',
        );
      }
    });
  }

  const updated = getAgent(agent.id) as Agent;
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });

  logger.info(
    {
      task_id: task.id,
      agent_id: agent.id,
      operation: 'respawn_fresh',
      window_index: newWindowIndex,
      harness_session_id: updated.harness_session_id,
    },
    'respawn_fresh: complete',
  );

  return updated;
}
