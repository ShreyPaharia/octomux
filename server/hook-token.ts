import crypto from 'crypto';
import { getTaskRuntimeState, setAgentHookToken } from './repositories/index.js';
import { getHarness } from './harnesses/index.js';
import { hookBaseUrl } from './hook-base-url.js';
import type { Agent } from './types.js';
import { childLogger } from './logger.js';

const logger = childLogger('hook-token');

/**
 * Backfills `hook_token` for an agent that was created before step 1
 * introduced per-agent hook authentication. If the agent already has a
 * token or its parent task is not actively running (runtime_state is
 * 'idle' — the state closeTask sets), returns the current value as a
 * no-op. On a fresh mint, also re-runs `harness.installHooks` against
 * `worktreePath` so the worktree config gains the token.
 *
 * Note: the schema has no 'closed' runtime_state value. Tasks that have
 * been closed have runtime_state = 'idle'. We gate on that to avoid
 * spurious writes to worktrees that are no longer actively running.
 */
export async function ensureHookToken(agent: Agent, worktreePath: string | null): Promise<string> {
  if (agent.hook_token && agent.hook_token !== '') return agent.hook_token;

  if (agent.task_id) {
    const task = getTaskRuntimeState(agent.task_id);
    if (!task || task.runtime_state === 'idle') return '';
  }

  const token = crypto.randomBytes(32).toString('hex');
  setAgentHookToken(agent.id, token);

  if (worktreePath) {
    try {
      await getHarness(agent.harness_id).installHooks(worktreePath, hookBaseUrl(), token);
    } catch (err) {
      logger.warn(
        { agent_id: agent.id, err: (err as Error).message },
        'failed to refresh hook config on backfill',
      );
    }
  }

  return token;
}
