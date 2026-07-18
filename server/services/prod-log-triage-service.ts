/**
 * Service layer for prod-log-triage run-start (cron → task → retry loop).
 * HTTP-agnostic. Mirrors pr-extract-service.ts's insert→startTask shape, but
 * follows startTask with startLoop — this vertical retries until `verify`
 * passes instead of running once.
 */

import { nanoid } from 'nanoid';
import { buildTriagePrompt, insertTriageTask } from '../prod-log-triage-tasks.js';
import { repoShortName } from '../review-tasks.js';
import { getTask, findFirstActiveAgent } from '../repositories/index.js';
import { startTask } from '../task-engine/index.js';
import { startLoop } from '../task-engine/loop/engine.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { Task } from '../types.js';

const logger = childLogger('prod-log-triage-service');

export interface CreateTriageTaskFromScheduleInput {
  repoPath: string;
  logCommand: string;
  verify: string;
  maxIterations: number;
  /** Set when this run was fired by a schedule — stamps tasks.schedule_id. */
  scheduleId?: string;
}

export interface CreateTriageTaskResult {
  id: string;
  task: Task;
}

export async function createTriageTaskFromSchedule(
  input: CreateTriageTaskFromScheduleInput,
): Promise<CreateTriageTaskResult> {
  const id = nanoid(12);
  const short = repoShortName(input.repoPath);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const branch = `triage/${short}-${dateStamp}`;

  const initialPrompt = buildTriagePrompt({
    triageTaskId: id,
    repoShort: short,
    logCommand: input.logCommand,
  });

  insertTriageTask({
    id,
    repoPath: input.repoPath,
    branch,
    baseBranch: 'main',
    title: `Prod log triage: ${short} (${dateStamp})`,
    description: `Scheduled prod-log-triage run for ${short}`,
    initialPrompt,
    scheduleId: input.scheduleId,
  });

  broadcast({ type: 'task:created', payload: { taskId: id } });

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
      'prod-log-triage: startTask did not produce a live agent — skipping startLoop',
    );
    broadcast({ type: 'task:updated', payload: { taskId: id } });
    return { id, task: settled ?? fresh };
  }

  await startLoop(id, {
    prompt: initialPrompt,
    verify: input.verify,
    maxIterations: input.maxIterations,
  });

  logger.info({ task_id: id, repo_path: input.repoPath }, 'prod-log-triage task created');
  return { id, task: getTask(id) ?? settled };
}
