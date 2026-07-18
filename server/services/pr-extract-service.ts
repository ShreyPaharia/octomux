/**
 * Service layer for pr-extract task orchestration. HTTP-agnostic.
 *
 * De-dup boundary: callers own ALL pre-create work (PR/repo resolution,
 * existing-extract dedup). This function is the create/trigger TAIL only.
 */

import { nanoid } from 'nanoid';
import { buildPrExtractPrompt, insertExtractTask } from '../pr-extract-tasks.js';
import { repoShortName } from '../review-tasks.js';
import { getTask, insertRun } from '../repositories/index.js';
import { startTask } from '../task-engine/index.js';
import { broadcast } from '../events.js';
import { childLogger } from '../logger.js';
import type { Task } from '../types.js';

const logger = childLogger('pr-extract-service');

export interface CreateExtractFromMergedPrInput {
  repo_path: string;
  branch: string;
  base_branch: string;
  pr_number: number;
  pr_url: string | null;
  pr_head_sha: string;
  title: string;
}

export interface CreateExtractTaskResult {
  id: string;
  task: Task;
}

export async function createExtractTaskFromMergedPr(
  input: CreateExtractFromMergedPrInput,
): Promise<CreateExtractTaskResult> {
  const id = nanoid(12);
  const short = repoShortName(input.repo_path);
  const branch = `extract/${short}-pr-${input.pr_number}`;

  const initialPrompt = buildPrExtractPrompt({
    extractTaskId: id,
    title: input.title,
    number: input.pr_number,
    url: input.pr_url ?? '',
    headRefOid: input.pr_head_sha,
    repoShort: short,
  });

  insertExtractTask({
    id,
    repoPath: input.repo_path,
    branch,
    baseBranch: input.base_branch,
    title: `Extract: ${input.title} (#${input.pr_number})`,
    description: `PR-extract task for merged PR #${input.pr_number}`,
    initialPrompt,
    prUrl: input.pr_url,
    prNumber: input.pr_number,
    prHeadSha: input.pr_head_sha,
  });

  broadcast({ type: 'task:created', payload: { taskId: id } });

  insertRun({ workflowKind: 'pr-extract', trigger: 'github', taskId: id });

  const fresh = getTask(id) as Task;
  fresh.agents = [];
  fresh.user_terminals = [];

  startTask(fresh)
    .then(() => broadcast({ type: 'task:updated', payload: { taskId: id } }))
    .catch((err) => {
      logger.error(
        { task_id: id, err: (err as Error).message },
        'failed to auto-start pr-extract task',
      );
      broadcast({ type: 'task:updated', payload: { taskId: id } });
    });

  logger.info({ task_id: id, pr_number: input.pr_number }, 'pr-extract task created');
  return { id, task: fresh };
}
