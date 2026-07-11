import { getSettings } from '../../settings.js';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { syncSkills } from '../../skills.js';
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
 */
export async function respawnAgentFresh(task: Task, agent: Agent): Promise<Agent> {
  logger.info(
    { task_id: task.id, agent_id: agent.id, operation: 'respawn_fresh' },
    'respawn_fresh: start',
  );

  const harness = getHarness(agent.harness_id);
  const flags = harness.resolveFlags(await getSettings());
  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await harness.syncAgents(task.worktree!);
  await syncSkills(task.worktree!);
  await harness.installHooks(task.worktree!, hookBaseUrl(), agent.hook_token);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: agent.agent,
    flags,
    model: (task as { model?: string | null }).model ?? null,
    workspacePath: task.worktree!,
  });
  const startupCmd = buildAgentStartupCommand({ baseCmd });

  const oldWindowIndex = agent.window_index;
  const newWindowIndex = await launchAgentWindow({
    session: task.tmux_session!,
    cwd: task.worktree!,
    startupCmd,
    fresh: false,
  });

  setAgentWindowRunning(agent.id, newWindowIndex);
  if (harness.sessionIdMode === 'orchestrator-assigned' && sessionIdForDb) {
    setAgentHarnessSessionId(agent.id, sessionIdForDb);
  }

  const target = `${task.tmux_session}:${newWindowIndex}`;
  void harness.postLaunch?.(target);

  await execTmux(['kill-window', '-t', `${task.tmux_session}:${oldWindowIndex}`]).catch((err) => {
    if (!isTmuxTargetMissing(err)) {
      logger.warn(
        { task_id: task.id, agent_id: agent.id, operation: 'respawn_fresh', err },
        'respawn_fresh: kill old window failed',
      );
    }
  });

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
