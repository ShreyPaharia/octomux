import { nanoid } from 'nanoid';
import { createTask } from './task-service.js';
import { getTask } from '../repositories/tasks.js';
import { startLoop } from '../task-engine/loop/engine.js';
import {
  createLoopGroup,
  getLoopGroup,
  listLoopRunsForGroup,
  setJudgeRunning,
} from '../repositories/loop-groups.js';
import { insertRun } from '../repositories/runs.js';
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
  /** Set when this group was fired by a schedule; defaults to 'manual' (dashboard/CLI). */
  trigger?: 'cron' | 'manual';
}

/**
 * Fans out N fresh tasks/worktrees off the same base branch and starts an identical LoopSpec
 * loop on each, tagging every resulting loop_run with the new group's id.
 *
 * Adoption fix (see spec/workflow-consolidation.md discussion in routes/runs.ts's module doc):
 * this used to never call `insertRun`, so a best-of-N group and its candidates were invisible to
 * GET /api/runs. Now it creates ONE `runs` row for the group itself (workflow_kind:'loop-group',
 * linked back via `loop_groups.run_id` — the group has no single `task_id` to key a forward link
 * off, unlike a plain loop) plus one `runs` row per candidate (workflow_kind:'loop', linked via
 * `runs.loop_run_id` and threaded into `spec.runId`, exactly like a standalone loop / doc-drift /
 * prod-log-triage). Every candidate's own `octomux emit --run <id>` targets ITS OWN runs.id, not
 * the group's — the group's runs.id is only ever addressed by `octomux judge-emit`.
 */
export async function createLoopGroupWithCandidates(
  input: CreateLoopGroupServiceInput,
): Promise<{ group: LoopGroup; loopRuns: LoopRun[] }> {
  const trigger = input.trigger ?? 'manual';
  const groupRunsRow = insertRun({ workflowKind: 'loop-group', trigger });

  const group = createLoopGroup({
    spec_json: JSON.stringify(input.spec),
    n: input.n,
    repo_path: input.repoPath,
    base_branch: input.baseBranch,
    run_id: groupRunsRow.id,
  });

  const loopRuns = await Promise.all(
    Array.from({ length: input.n }, async (_unused, i) => {
      const task = await createTask(
        candidateTaskInput(input.repoPath, input.baseBranch, input.spec, i, input.n),
      );
      await waitForTaskRunning(task.id);

      const loopRunId = nanoid(12);
      const candidateRunsRow = insertRun({
        workflowKind: 'loop',
        trigger,
        taskId: task.id,
        loopRunId,
      });
      return startLoop(task.id, { ...input.spec, runId: candidateRunsRow.id }, group.id, loopRunId);
    }),
  );

  logger.info(
    { loop_group_id: group.id, run_id: groupRunsRow.id, n: input.n },
    'loop_group: candidates launched',
  );
  return { group, loopRuns };
}

export function buildJudgePrompt(group: LoopGroup, loopRuns: LoopRun[]): string {
  const spec = JSON.parse(group.spec_json) as LoopSpec;
  // The id namespace for `--group` moved from loop_groups.id to runs.id (see routes/runs.ts's
  // module doc) — `group.run_id` ?? `group.id` fallback only matters for a pre-migration row
  // that predates the reverse link (breaking those in-flight groups is accepted).
  const groupRunId = group.run_id ?? group.id;
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
    `octomux judge-emit --group ${groupRunId} --winner <winning loop run id> --rationale "<why, 2-4 sentences>"`,
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
