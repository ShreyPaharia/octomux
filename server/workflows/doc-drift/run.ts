/**
 * Service layer for doc-drift run-start (cron → task → retry loop).
 * HTTP-agnostic. Mirrors prod-log-triage-service.ts's insert→startTask shape,
 * followed by startLoop — this vertical retries until `verify` passes instead
 * of running once.
 */

import { nanoid } from 'nanoid';
import { buildDocDriftPrompt, insertDocDriftTask } from '../../doc-drift-tasks.js';
import { repoShortName } from '../../review-tasks.js';
import { getTask, findFirstActiveAgent, insertRun } from '../../repositories/index.js';
import { finishRun } from '../../repositories/runs.js';
import { startTask } from '../../task-engine/index.js';
import { startLoop } from '../../task-engine/loop/engine.js';
import { broadcast } from '../../events.js';
import { childLogger } from '../../logger.js';
import type { Task, RunResult } from '../../types.js';

const logger = childLogger('workflows/doc-drift');

export interface CreateDocDriftTaskFromScheduleInput {
  repoPath: string;
  verify: string;
  maxIterations: number;
  /** Set when this run was fired by a schedule — stamps tasks.schedule_id. */
  scheduleId?: string;
  trigger?: 'cron' | 'manual';
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

  const fresh = getTask(id) as Task;
  fresh.agents = [];
  fresh.user_terminals = [];

  await startTask(fresh);

  // M1 guard: startTask catches its own setup failures and resolves anyway
  // (lifecycle/start-task.ts sets runtime_state='error' and returns — it does
  // NOT reject). Only kick off the retry loop once a live agent actually
  // exists; otherwise startLoop would throw "no active agent" synchronously.
  //
  // The runs row is created HERE, once we know which branch we're in, rather
  // than optimistically before startTask — that earlier placement is why
  // this guard path used to leave a run stuck at status='running' forever
  // (see spec/workflow-consolidation.md §1.2). Finish it as 'failed'
  // immediately since no loop will ever reach engine.ts's termination site
  // to do it for us.
  const settled = getTask(id);
  const activeAgent = findFirstActiveAgent(id);
  const trigger = input.trigger ?? 'cron';
  if (!settled || settled.runtime_state === 'error' || !activeAgent) {
    logger.warn(
      { task_id: id, runtime_state: settled?.runtime_state },
      'doc-drift: startTask did not produce a live agent — skipping startLoop',
    );
    const failedRun = insertRun({
      workflowKind: 'doc-drift',
      trigger,
      scheduleId: input.scheduleId,
      taskId: id,
    });
    finishRun(failedRun.id, {
      status: 'failed',
      result: {
        outcome: 'failed',
        summary: 'Task setup failed before the retry loop could start.',
      } satisfies RunResult,
    });
    broadcast({ type: 'task:updated', payload: { taskId: id } });
    return { id, task: settled ?? fresh };
  }

  const loopRunId = nanoid(12);
  const runsRow = insertRun({
    workflowKind: 'doc-drift',
    trigger,
    scheduleId: input.scheduleId,
    taskId: id,
    loopRunId,
  });

  await startLoop(
    id,
    {
      prompt: initialPrompt,
      verify: input.verify,
      maxIterations: input.maxIterations,
      runId: runsRow.id,
    },
    undefined,
    loopRunId,
  );

  logger.info({ task_id: id, repo_path: input.repoPath }, 'doc-drift task created');
  return { id, task: getTask(id) ?? settled };
}
