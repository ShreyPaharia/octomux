import path from 'path';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { getHarness } from '../../harnesses/index.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { resolveHarnessFlags } from '../../harness-flags.js';
import { skillContentOverridesForScheduleId } from '../../schedule-prompt.js';
import { childLogger } from '../../logger.js';
import {
  listActiveAgents,
  getTaskHookToken,
  insertAgentWithNotify,
} from '../../repositories/index.js';
import { buildAgentStartupCommand, launchAgentWindow, computeFreshSessionIds } from '../launch.js';
import { sessionFor } from '../../compute/index.js';
import type { ComputeSession } from '../../compute/types.js';
import type { Worker, Task } from '../../types.js';
import type { AddAgentOpts } from './types.js';

const logger = childLogger('task-engine/lifecycle');

export interface ResolvedAddAgentOpts {
  resolvedAgent: string | null;
  label: string;
  resolvedPrompt: string | undefined;
  notifyAgentId: string | null;
}

/** Validate skeleton path and resolve prompt/label/agent fields. */
export async function validateAndResolveAddAgentOpts(
  c: ComputeSession,
  task: Task,
  opts: AddAgentOpts = {},
): Promise<ResolvedAddAgentOpts> {
  const resolvedAgent = opts.agent ?? null;
  const activeAgents = listActiveAgents(task.id);
  const label = opts.label ?? `Agent ${activeAgents.length + 1}`;

  let resolvedPrompt = opts.prompt;
  if (opts.skeleton) {
    const skeletonPath = path.join(task.worktree!, '.octomux', 'agents', `${opts.skeleton}.md`);
    const skeletonContent = await c.files.read(skeletonPath);
    if (skeletonContent === null) {
      throw new Error(`skeleton not found: ${opts.skeleton} (expected at ${skeletonPath})`);
    }
    resolvedPrompt = opts.prompt
      ? `${skeletonContent}\n\n# Task\n\n${opts.prompt}`
      : skeletonContent;
  }

  return {
    resolvedAgent,
    label,
    resolvedPrompt,
    notifyAgentId: opts.notify_agent_id ?? null,
  };
}

export interface PreparedAddAgentLaunch {
  agentId: string;
  hookToken: string;
  sessionIdForDb: string | null;
  startupCmd: string;
  harness: ReturnType<typeof getHarness>;
}

/** Sync harness hooks/skills and build the startup command for a new agent window. */
export async function prepareAddAgentLaunch(
  c: ComputeSession,
  task: Task,
  resolved: ResolvedAddAgentOpts,
  opts: AddAgentOpts = {},
): Promise<PreparedAddAgentLaunch> {
  const harness = getHarness(task.harness_id);
  const agentId = nanoid(12);
  const existingTokenRow = getTaskHookToken(task.id);
  const hookToken = existingTokenRow?.hook_token ?? crypto.randomBytes(32).toString('hex');
  const flags = await resolveHarnessFlags(harness, {
    skillContentOverrides: await skillContentOverridesForScheduleId(
      (task as { schedule_id?: string | null }).schedule_id,
    ),
  });
  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await harness.installHooks(task.worktree!, hookBaseUrl(), hookToken, c.files);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: resolved.resolvedAgent,
    flags,
    model: opts.model ?? (task as any).model ?? null,
    workspacePath: task.worktree!,
  });
  const startupCmd = await buildAgentStartupCommand(c, {
    baseCmd,
    prompt: resolved.resolvedPrompt,
    worktreePath: task.worktree!,
    agentId,
    harness,
  });

  return { agentId, hookToken, sessionIdForDb, startupCmd, harness };
}

/** Launch a new tmux window for the agent. */
export async function launchAddAgentWindow(
  c: ComputeSession,
  task: Task,
  startupCmd: string,
): Promise<number> {
  return launchAgentWindow(c, {
    session: task.tmux_session!,
    cwd: task.worktree!,
    startupCmd,
    fresh: false,
  });
}

/** Insert the agent DB row, fire post-launch hook, and return the Agent record. */
export function persistAddAgentRow(
  task: Task,
  resolved: ResolvedAddAgentOpts,
  prepared: PreparedAddAgentLaunch,
  windowIndex: number,
): Worker {
  const addTarget = `${task.tmux_session}:${windowIndex}`;

  insertAgentWithNotify({
    id: prepared.agentId,
    task_id: task.id,
    window_index: windowIndex,
    label: resolved.label,
    harness_id: prepared.harness.id,
    harness_session_id: prepared.sessionIdForDb,
    hook_token: prepared.hookToken,
    agent: resolved.resolvedAgent,
    notify_agent_id: resolved.notifyAgentId,
  });

  void prepared.harness.postLaunch?.(addTarget);

  return {
    id: prepared.agentId,
    task_id: task.id,
    window_index: windowIndex,
    label: resolved.label,
    status: 'running',
    harness_id: prepared.harness.id,
    harness_session_id: prepared.sessionIdForDb,
    hook_token: prepared.hookToken,
    hook_activity: 'active' as const,
    hook_activity_updated_at: null,
    tmux_session: null,
    agent: resolved.resolvedAgent,
    notify_agent_id: resolved.notifyAgentId,
    created_at: new Date().toISOString(),
  };
}

export async function addAgent(task: Task, opts: AddAgentOpts = {}): Promise<Worker> {
  logger.info(
    { task_id: task.id, operation: 'addAgent', agent: opts.agent ?? null },
    'addAgent: start',
  );

  const compute = await sessionFor(task);
  const resolved = await validateAndResolveAddAgentOpts(compute, task, opts);
  const prepared = await prepareAddAgentLaunch(compute, task, resolved, opts);
  const windowIndex = await launchAddAgentWindow(compute, task, prepared.startupCmd);
  const agent = persistAddAgentRow(task, resolved, prepared, windowIndex);

  logger.info(
    {
      task_id: task.id,
      agent_id: agent.id,
      operation: 'addAgent',
      window_index: windowIndex,
      harness: prepared.harness.id,
      harness_session_id: prepared.sessionIdForDb,
    },
    'addAgent: claude launched',
  );

  return agent;
}
