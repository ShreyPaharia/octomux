import { createTask } from './task-service.js';
import { getTask } from '../repositories/tasks.js';
import { startLoop } from '../task-engine/loop/engine.js';
import {
  createLoopGroup,
  getLoopGroup,
  listLoopRunsForGroup,
  setJudgeRunning,
} from '../repositories/loop-groups.js';
import { badRequest, notFound, conflict } from './errors.js';
import { childLogger } from '../logger.js';
import type { LoopSpec, LoopRun, LoopGroup } from '../types.js';

const logger = childLogger('loop-group-service');

async function waitForTaskRunning(
  taskId: string,
  timeoutMs = 60_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = getTask(taskId);
    if (!task) throw new Error(`waitForTaskRunning: task not found: ${taskId}`);
    if (task.runtime_state === 'running') return;
    if (task.runtime_state === 'error') {
      throw new Error(`candidate task ${taskId} failed to start: ${task.error ?? 'unknown error'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitForTaskRunning: timed out waiting for task ${taskId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function candidateTaskInput(
  repoPath: string,
  baseBranch: string,
  spec: LoopSpec,
  index: number,
  n: number,
) {
  return {
    resolved_title: `Best-of-N ${index + 1}/${n}: ${spec.prompt.slice(0, 60)}`,
    resolved_description: spec.prompt,
    initial_prompt: null,
    run_mode: 'new' as const,
    stored_repo_path: repoPath,
    staged_path: '',
    branch: null,
    base_branch: baseBranch,
    worktree_status: 'available' as const,
    runtime_state: 'setting_up',
    workflow_status: 'planned',
    agent: null,
    harness_id: 'claude-code',
    model: null,
    notify_task_id: null,
    is_draft: false,
  };
}

export interface CreateLoopGroupServiceInput {
  repoPath: string;
  baseBranch: string;
  spec: LoopSpec;
  n: number;
}

/** Fans out N fresh tasks/worktrees off the same base branch and starts an identical LoopSpec
 * loop on each, tagging every resulting loop_run with the new group's id. */
export async function createLoopGroupWithCandidates(
  input: CreateLoopGroupServiceInput,
): Promise<{ group: LoopGroup; loopRuns: LoopRun[] }> {
  const group = createLoopGroup({
    spec_json: JSON.stringify(input.spec),
    n: input.n,
    repo_path: input.repoPath,
    base_branch: input.baseBranch,
  });

  const loopRuns = await Promise.all(
    Array.from({ length: input.n }, async (_unused, i) => {
      const task = await createTask(
        candidateTaskInput(input.repoPath, input.baseBranch, input.spec, i, input.n),
      );
      await waitForTaskRunning(task.id);
      return startLoop(task.id, input.spec, group.id);
    }),
  );

  logger.info({ loop_group_id: group.id, n: input.n }, 'loop_group: candidates launched');
  return { group, loopRuns };
}

export function buildJudgePrompt(group: LoopGroup, loopRuns: LoopRun[]): string {
  const spec = JSON.parse(group.spec_json) as LoopSpec;
  const candidateLines = loopRuns.map(
    (r, i) =>
      `- Candidate ${i + 1}: loop run id ${r.id}, task id ${r.task_id}, branch agents/${r.task_id}, ` +
      `status ${r.status}${r.termination_reason ? ` (${r.termination_reason})` : ''}`,
  );
  return [
    `You are judging ${loopRuns.length} candidate solutions produced by independent agent loops,`,
    `all started from base branch "${group.base_branch}" against the same task:`,
    '',
    spec.prompt,
    '',
    'Candidates:',
    ...candidateLines,
    '',
    `Inspect each candidate with \`git diff ${group.base_branch}..agents/<task id>\` — all candidate`,
    'branches are local to this repo. Weigh correctness, completeness against the task, and code',
    'quality. This is advisory only: a human makes the final call.',
    '',
    'When you have decided, report your pick:',
    `octomux judge-emit --group ${group.id} --winner <winning loop run id> --rationale "<why, 2-4 sentences>"`,
  ].join('\n');
}

/** Spawns the judge as one ordinary (non-loop) task — ponytail: no worktree cleanup for the judge
 * task once it's done; add if judge tasks visibly pile up in the task list. */
export async function launchJudge(groupId: string): Promise<LoopGroup> {
  const group = getLoopGroup(groupId);
  if (!group) throw notFound('Loop group not found');
  if (group.judge_status === 'running') throw conflict('Judge already running for this group');

  const loopRuns = listLoopRunsForGroup(groupId);
  if (loopRuns.length === 0) throw badRequest('Loop group has no candidates');
  if (loopRuns.some((r) => r.status === 'running')) {
    throw conflict('Candidates still running — judge can only run once all are terminal');
  }

  setJudgeRunning(groupId);

  await createTask({
    resolved_title: `Judge: best-of-N ${groupId}`,
    resolved_description: 'Advisory judge picking a winner among best-of-N candidates.',
    initial_prompt: buildJudgePrompt(group, loopRuns),
    run_mode: 'new',
    stored_repo_path: group.repo_path,
    staged_path: '',
    branch: null,
    base_branch: group.base_branch,
    worktree_status: 'available',
    runtime_state: 'setting_up',
    workflow_status: 'planned',
    agent: null,
    harness_id: 'claude-code',
    model: null,
    notify_task_id: null,
    is_draft: false,
  });

  logger.info({ loop_group_id: groupId }, 'loop_group: judge task launched');
  return getLoopGroup(groupId) as LoopGroup;
}
