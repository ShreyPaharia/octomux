import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { broadcast } from '../events.js';
import { fireHook } from '../hook-dispatcher.js';
import { childLogger } from '../logger.js';
import {
  setTaskPrDetected,
  addTaskUpdate,
  listTasksNeedingPrDetection,
} from '../repositories/tasks.js';
import type { Task } from '../types.js';
import { repoNameWithOwner } from './github-repo.js';

const logger = childLogger('poller');
const execFile = promisify(execFileCb);

export async function detectPR(task: Task): Promise<{ url: string; number: number } | null> {
  if (!task.branch || !task.repo_path) return null;
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'list', '--head', task.branch, '--json', 'url,number', '--limit', '1'],
      { cwd: task.repo_path },
    );
    const prs = JSON.parse(stdout.trim() || '[]');
    if (prs.length > 0) {
      return { url: prs[0].url, number: prs[0].number };
    }
    return null;
  } catch {
    return null;
  }
}

export async function pollPRs(): Promise<void> {
  const tasks = listTasksNeedingPrDetection();
  if (tasks.length === 0) return;

  const eligible: Array<{ task: Task; owner: string; name: string; branch: string }> = [];
  for (const task of tasks) {
    if (!task.repo_path || !task.branch) continue;
    const nwo = await repoNameWithOwner(task.repo_path);
    if (!nwo) continue;
    const [owner, name] = nwo.split('/');
    if (!owner || !name) continue;
    eligible.push({ task, owner, name, branch: task.branch });
  }
  if (eligible.length === 0) return;

  const aliasFragments = eligible
    .map(
      ({ owner, name, branch }, i) =>
        `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequests(headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url } } }`,
    )
    .join('\n  ');
  const query = `query { ${aliasFragments} }`;

  let parsed: {
    data?: Record<
      string,
      { pullRequests: { nodes: Array<{ number: number; url: string }> } } | null
    >;
  } = {};
  try {
    const { stdout } = await execFile('gh', ['api', 'graphql', '-f', `query=${query}`]);
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/rate limit/i.test(msg)) {
      logger.warn('gh rate limit hit on PR detection — backing off until next cycle');
    } else {
      logger.debug({ err: msg }, 'gh api graphql for PR detection failed');
    }
    return;
  }

  for (const [i, { task }] of eligible.entries()) {
    const node = parsed.data?.[`pr${i}`]?.pullRequests?.nodes?.[0];
    const pr = node ? { url: node.url, number: node.number } : null;
    if (pr) {
      const prevWorkflow = task.workflow_status;
      const shouldFlipToPr = prevWorkflow === 'in_progress' || prevWorkflow === 'human_review';
      setTaskPrDetected(task.id, pr.url, pr.number);

      if (shouldFlipToPr) {
        addTaskUpdate({
          task_id: task.id,
          kind: 'transition',
          from_status: prevWorkflow,
          to_status: 'pr',
          body: 'auto: PR opened',
        });
        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: {
            ...task,
            pr_url: pr.url,
            pr_number: pr.number,
            workflow_status: 'pr' as import('../types.js').WorkflowStatus,
          },
          data: { from: prevWorkflow, to: 'pr', note: 'auto: PR opened' },
        });
      }
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    }
  }
}
