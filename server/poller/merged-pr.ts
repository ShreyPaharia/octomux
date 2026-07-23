import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { broadcast } from '../events.js';
import { fireHook } from '../hook-dispatcher.js';
import { childLogger } from '../logger.js';
import { closeTask } from '../task-engine/index.js';
import {
  listRunningTasksWithPr,
  addTaskUpdate,
  setWorkflowStatusDone,
  findExistingPrTask,
} from '../repositories/tasks.js';
import { getWorkflow } from '../workflows/registry.js';
import type { Task } from '../types.js';
import { repoNameWithOwner } from './github-repo.js';

const logger = childLogger('poller');
const execFile = promisify(execFileCb);

export async function checkMergedPRs(): Promise<void> {
  const tasks = listRunningTasksWithPr();
  if (tasks.length === 0) return;

  const eligible: Array<{ task: Task; owner: string; name: string }> = [];
  for (const task of tasks) {
    if (!task.repo_path || !task.pr_number) continue;
    const nwo = await repoNameWithOwner(task.repo_path);
    if (!nwo) continue;
    const [owner, name] = nwo.split('/');
    if (!owner || !name) continue;
    eligible.push({ task, owner, name });
  }
  if (eligible.length === 0) return;

  const aliasFragments = eligible
    .map(
      ({ owner, name, task }, i) =>
        `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${task.pr_number}) { state } }`,
    )
    .join('\n  ');
  const query = `query { ${aliasFragments} }`;

  let parsed: {
    data?: Record<string, { pullRequest: { state: string } | null } | null>;
  } = {};
  try {
    const { stdout } = await execFile('gh', ['api', 'graphql', '-f', `query=${query}`]);
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn('gh rate limit hit on merged-PR check — backing off until next cycle');
    } else {
      logger.debug({ err: msg }, 'gh api graphql for merged PR check failed');
    }
    return;
  }

  for (const [i, { task }] of eligible.entries()) {
    const state = parsed.data?.[`pr${i}`]?.pullRequest?.state;
    if (state === 'MERGED') {
      try {
        const prevWorkflow = task.workflow_status;
        await closeTask(task);
        setWorkflowStatusDone(task.id);
        addTaskUpdate({
          task_id: task.id,
          kind: 'transition',
          from_status: prevWorkflow,
          to_status: 'done',
          body: 'auto: PR merged',
        });
        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: { ...task, workflow_status: 'done' as import('../types.js').WorkflowStatus },
          data: { from: prevWorkflow, to: 'done', note: 'auto: PR merged' },
        });
        broadcast({ type: 'task:updated', payload: { taskId: task.id } });

        if (task.repo_path && task.pr_number != null && task.pr_head_sha) {
          const existingExtract = findExistingPrTask(task.repo_path, task.pr_number);
          const alreadyExtracted =
            existingExtract?.source === 'pr_extract' &&
            existingExtract.pr_head_sha === task.pr_head_sha;
          if (!alreadyExtracted) {
            const wf = getWorkflow('pr-extract');
            await wf
              ?.run?.({
                repoPath: task.repo_path,
                config: {},
                event: {
                  branch: task.base_branch ?? 'main',
                  base_branch: task.base_branch ?? 'main',
                  pr_number: task.pr_number,
                  pr_url: task.pr_url,
                  pr_head_sha: task.pr_head_sha,
                  title: task.title,
                },
              })
              .catch((err) => {
                logger.error(
                  { task_id: task.id, err: (err as Error).message },
                  'failed to create pr-extract task for merged PR',
                );
              });
          }
        }
      } catch {
        // closeTask failure shouldn't stop processing other tasks
      }
    }
  }
}

export async function pollMergedPRs(): Promise<void> {
  try {
    await checkMergedPRs();
  } catch (err) {
    logger.error({ err, operation: 'pollMergedPRs' }, 'pollMergedPRs failed');
  }
}
