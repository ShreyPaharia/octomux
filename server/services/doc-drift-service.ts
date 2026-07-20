/**
 * Service layer for doc-drift run-start (cron → task → retry loop).
 * HTTP-agnostic. Mirrors prod-log-triage-service.ts's insert→startTask shape,
 * followed by startLoop — this vertical retries until `verify` passes instead
 * of running once.
 */

import { nanoid } from 'nanoid';
import { buildDocDriftPrompt, insertDocDriftTask } from '../doc-drift-tasks.js';
import { repoShortName } from '../review-tasks.js';
import { getTask, findFirstActiveAgent, insertRun } from '../repositories/index.js';
import { startTask } from '../task-engine/index.js';
import { startLoop } from '../task-engine/loop/engine.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { Task } from '../types.js';

const logger = childLogger('doc-drift-service');

export interface CreateDocDriftTaskFromScheduleInput {
  repoPath: string;
  verify: string;
  maxIterations: number;
  /** Set when this run was fired by a schedule — stamps tasks.schedule_id. */
  scheduleId?: string;
}

export interface CreateDocDriftTaskResult {
  id: string;
  task: Task;
}

export async function createDocDriftTaskFromSchedule(
  input: CreateDocDriftTaskFromScheduleInput,
): Promise<CreateDocDriftTaskResult> {
  const id = nanoid(12);
  const short = repoShortName(input.repoPath);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const branch = `doc-drift/${short}-${dateStamp}`;

  const initialPrompt = buildDocDriftPrompt({
    docDriftTaskId: id,
    repoShort: short,
  });

  insertDocDriftTask({
    id,
    repoPath: input.repoPath,
    branch,
    baseBranch: 'main',
    title: `Doc drift: ${short} (${dateStamp})`,
    description: `Scheduled doc-drift run for ${short}`,
    initialPrompt,
    scheduleId: input.scheduleId,
  });

  broadcast({ type: 'task:created', payload: { taskId: id } });

  insertRun({
    workflowKind: 'doc-drift',
    trigger: 'cron',
    scheduleId: input.scheduleId,
    taskId: id,
  });

  const fresh = getTask(id) as Task;
  fresh.agents = [];
  fresh.user_terminals = [];

  await startTask(fresh);

  // M1 guard: startTask catches its own setup failures and resolves anyway
  // (lifecycle/start-task.ts sets runtime_state='error' and returns — it does
  // NOT reject). Only kick off the retry loop once a live agent actually
  // exists; otherwise startLoop would throw "no active agent" synchronously.
  const settled = getTask(id);
  const activeAgent = findFirstActiveAgent(id);
  if (!settled || settled.runtime_state === 'error' || !activeAgent) {
    logger.warn(
      { task_id: id, runtime_state: settled?.runtime_state },
      'doc-drift: startTask did not produce a live agent — skipping startLoop',
    );
    broadcast({ type: 'task:updated', payload: { taskId: id } });
    return { id, task: settled ?? fresh };
  }

  await startLoop(id, {
    prompt: initialPrompt,
    verify: input.verify,
    maxIterations: input.maxIterations,
  });

  logger.info({ task_id: id, repo_path: input.repoPath }, 'doc-drift task created');
  return { id, task: getTask(id) ?? settled };
}
