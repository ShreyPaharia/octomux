import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { broadcast } from '../events.js';
import { fireHook } from '../hook-dispatcher.js';
import { childLogger } from '../logger.js';
import { addTaskUpdate, listTasksNeedingPrDetection, getTask } from '../repositories/tasks.js';
import { upsertPullRequest, syncDerivedPrimaryPr } from '../repositories/pull-requests.js';
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

/**
 * Enumerate candidate branches for a task: the task's own branch plus any
 * git branches whose name starts with the `agents/<taskid>` prefix (slice branches).
 * Returns deduplicated list; task.branch is always first.
 */
async function candidateBranches(task: Task): Promise<string[]> {
  if (!task.branch || !task.repo_path) return [];
  const branches = [task.branch];

  // Slice branches follow `agents/<id>-<slice>`; the base prefix is task.branch
  // (which itself is `agents/<id>`).
  const prefix = task.branch; // e.g. "agents/abc123def456"
  try {
    const { stdout } = await execFile('git', [
      '-C',
      task.repo_path,
      'branch',
      '--list',
      `${prefix}-*`,
    ]);
    for (const line of stdout.split('\n')) {
      const b = line.replace(/^\*?\s+/, '').trim();
      if (b && b !== prefix && !branches.includes(b)) {
        branches.push(b);
      }
    }
  } catch {
    // Not a fatal error — fall back to just the task's own branch.
  }
  return branches;
}

export async function pollPRs(): Promise<void> {
  const tasks = listTasksNeedingPrDetection();
  if (tasks.length === 0) return;

  // For each task, enumerate candidate branches (main + slice branches).
  // Build one flat list of (task, branch) entries to query in bulk.
  const entries: Array<{
    task: Task;
    owner: string;
    name: string;
    branch: string;
    baseBranch: string | null;
  }> = [];

  for (const task of tasks) {
    if (!task.repo_path || !task.branch) continue;
    const nwo = await repoNameWithOwner(task.repo_path);
    if (!nwo) continue;
    const [owner, name] = nwo.split('/');
    if (!owner || !name) continue;

    const branches = await candidateBranches(task);
    for (const branch of branches) {
      entries.push({ task, owner, name, branch, baseBranch: task.base_branch ?? null });
    }
  }

  if (entries.length === 0) return;

  // Build a single batched GraphQL query; one alias per (task, branch) entry.
  // Each alias requests: number, url, state.
  const aliasFragments = entries
    .map(
      ({ owner, name, branch }, i) =>
        `pr${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequests(headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url state } } }`,
    )
    .join('\n  ');
  const query = `query { ${aliasFragments} }`;

  let parsed: {
    data?: Record<
      string,
      { pullRequests: { nodes: Array<{ number: number; url: string; state: string }> } } | null
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

  // Group results back by task_id so we can run syncDerivedPrimaryPr once per task.
  const taskIds = new Set(entries.map((e) => e.task.id));

  for (const [i, { task, branch, baseBranch }] of entries.entries()) {
    const node = parsed.data?.[`pr${i}`]?.pullRequests?.nodes?.[0];
    if (!node) continue;

    // Map GitHub's OPEN / MERGED / CLOSED to our lowercase values.
    const ghState = node.state?.toUpperCase();
    const state = ghState === 'MERGED' ? 'merged' : ghState === 'CLOSED' ? 'closed' : 'open';

    upsertPullRequest({
      task_id: task.id,
      branch,
      base_branch: baseBranch,
      number: node.number,
      url: node.url,
      state,
    });
  }

  // Sync derived primary and fire workflow transitions for each affected task.
  for (const taskId of taskIds) {
    const taskBefore = entries.find((e) => e.task.id === taskId)!.task;
    const hadPrBefore = taskBefore.pr_url != null;

    syncDerivedPrimaryPr(taskId);

    // Re-read to get the updated pr_url (syncDerivedPrimaryPr writes tasks).
    const taskAfter = getTask(taskId);
    if (!taskAfter) continue;

    const prevWorkflow = taskBefore.workflow_status;
    const shouldFlipToPr = prevWorkflow === 'in_progress' || prevWorkflow === 'human_review';

    if (!hadPrBefore && taskAfter.pr_url) {
      // First PR detected for this task.
      if (shouldFlipToPr) {
        addTaskUpdate({
          task_id: taskId,
          kind: 'transition',
          from_status: prevWorkflow,
          to_status: 'pr',
          body: 'auto: PR opened',
        });
        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: {
            ...taskAfter,
            workflow_status: 'pr' as import('../types.js').WorkflowStatus,
          },
          data: { from: prevWorkflow, to: 'pr', note: 'auto: PR opened' },
        });
      }
      broadcast({ type: 'task:updated', payload: { taskId } });
    } else if (hadPrBefore) {
      // PR state may have changed — broadcast update anyway.
      broadcast({ type: 'task:updated', payload: { taskId } });
    }
  }
}
