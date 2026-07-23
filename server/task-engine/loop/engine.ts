import { childLogger } from '../../logger.js';
import { getTask, setRuntimeState } from '../../repositories/tasks.js';
import { getAgent, findFirstActiveAgent } from '../../repositories/agent-runtime.js';
import {
  createLoopRun,
  getActiveLoopRunForTask,
  appendIteration,
  listIterationsForRun,
  terminateLoopRun,
  resumeLoopRun,
  setLearningsSeeded,
} from '../../repositories/loop-runs.js';
import { revParseHead, commitAll } from '../git.js';
import { runVerify } from './verify.js';
import { writeLoopStatusFile } from './status-file.js';
import { respawnAgentFresh } from '../lifecycle/respawn-agent.js';
import { broadcast } from '../../events.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import { finishRun } from '../../repositories/runs.js';
import { LEARN_INSTRUCTION, fencedLearnings, seedLearnings } from './learn-prompt.js';
import type {
  LoopRun,
  LoopIteration,
  LoopSpec,
  LoopRunStatus,
  Task,
  RunResult,
} from '../../types.js';

const logger = childLogger('task-engine/loop');

export type TerminationReason =
  | 'done'
  | 'blocked'
  | 'needs_human'
  | 'max_iterations'
  | 'budget'
  | 'no_progress';

function loopRunIdLines(loopRunId: string): string[] {
  return [
    `Loop run id: ${loopRunId}`,
    `When your turn ends, report status: octomux emit --run ${loopRunId} --status <done|blocked|needs_human> --reason "<why>"`,
    LEARN_INSTRUCTION,
  ];
}

/** Build the prompt for a loop iteration, pinning the loop run id (mirrors reviewTaskIdLines in review-tasks.ts). */
export function buildLoopPrompt(
  spec: LoopSpec,
  loopRunId: string,
  verifyFailureOutput?: string | null,
  learnings: string[] = [],
): string {
  const lines = [spec.prompt, '', ...fencedLearnings(learnings), '', ...loopRunIdLines(loopRunId)];
  if (verifyFailureOutput) {
    lines.push(
      '',
      "The previous iteration's verify command failed. Fix it and continue:",
      '```',
      verifyFailureOutput.trim().slice(0, 4000),
      '```',
    );
  }
  return lines.join('\n');
}

function parseSqliteUtc(ts: string): number {
  return new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

export function trailingNoProgressStreak(iterations: LoopIteration[]): number {
  let count = 0;
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].sha_from === iterations[i].sha_to) count++;
    else break;
  }
  return count;
}

export function sumTokens(iterations: LoopIteration[]): number {
  return iterations.reduce((sum, it) => sum + (it.tokens ?? 0), 0);
}

export interface TerminationCtx {
  run: LoopRun;
  spec: LoopSpec;
  verifyPassed: boolean;
  iterationN: number;
  noProgressStreak: number;
  tokensUsed: number;
  now: number;
}

function isBudgetExhausted(ctx: TerminationCtx): boolean {
  const budget = ctx.spec.budget;
  if (!budget) return false;
  // ponytail: no per-turn token-usage signal is wired from the harness today, so
  // the tokens ceiling only trips once a future emit path populates
  // loop_iterations.tokens. timeMs is measurable today via loop_runs.created_at.
  if (budget.tokens != null && ctx.tokensUsed >= budget.tokens) return true;
  if (budget.timeMs != null) {
    const startedAt = parseSqliteUtc(ctx.run.created_at);
    if (ctx.now - startedAt >= budget.timeMs) return true;
  }
  return false;
}

/** Pure termination policy: stop on ANY of done+verified / blocked / needs_human / max_iterations / budget / no_progress. */
export function evaluateTermination(ctx: TerminationCtx): TerminationReason | null {
  if (ctx.run.status === 'blocked') return 'blocked';
  if (ctx.run.status === 'needs_human') return 'needs_human';
  if (ctx.run.status === 'done' && ctx.verifyPassed) return 'done';
  if (ctx.iterationN >= ctx.spec.maxIterations) return 'max_iterations';
  if (isBudgetExhausted(ctx)) return 'budget';
  if (ctx.spec.noProgress && ctx.noProgressStreak >= ctx.spec.noProgress.afterIters) {
    return 'no_progress';
  }
  return null;
}

function loopAgentEnv(taskId: string, hookToken: string): Record<string, string> {
  return {
    OCTOMUX_TASK_ID: taskId,
    OCTOMUX_ACTION_TOKEN: hookToken,
    OCTOMUX_ACTION_BASE_URL: hookBaseUrl(),
  };
}

/** Statuses that close a loop_run; non-emit terminations reuse 'needs_human' — the closed LoopRunStatus enum has no dedicated value for them (see plan Global Constraints). */
function finalStatusFor(reason: TerminationReason): LoopRunStatus {
  return reason === 'done' || reason === 'blocked' || reason === 'needs_human'
    ? reason
    : 'needs_human';
}

/** Maps the loop's termination policy onto the universal run-result outcome
 * (see spec/workflow-consolidation.md §5). needs_human counts as 'blocked' —
 * it means the loop is waiting on a person, not that it failed. */
const OUTCOME_FOR_REASON: Record<TerminationReason, RunResult['outcome']> = {
  done: 'done',
  blocked: 'blocked',
  needs_human: 'blocked',
  max_iterations: 'failed',
  budget: 'failed',
  no_progress: 'failed',
};

/**
 * Kick off a loop: create the loop_run, flip the task into 'looping', and
 * launch iteration 1 as a fresh-context respawn of the task's active agent
 * with the loop prompt (pinning the loop run id, mirroring how review prompts
 * pin the review-task id).
 *
 * `loopRunId`, when passed, pre-seeds the loop_run's own id (see
 * `CreateLoopRunInput.id`) so a caller can create the sibling `runs` row
 * FIRST with `loopRunId` known (bidirectional link, `runs.loop_run_id`)
 * while `spec.runId` carries the reverse link back into `spec_json` — see
 * doc-drift-service.ts / prod-log-triage-service.ts.
 */
export async function startLoop(
  taskId: string,
  spec: LoopSpec,
  groupId?: string,
  loopRunId?: string,
): Promise<LoopRun> {
  const task = getTask(taskId);
  if (!task) throw new Error(`startLoop: task not found: ${taskId}`);

  const agentRef = findFirstActiveAgent(taskId);
  if (!agentRef) throw new Error(`startLoop: no active agent for task ${taskId}`);
  const agent = getAgent(agentRef.id);
  if (!agent) throw new Error(`startLoop: agent not found: ${agentRef.id}`);

  const run = createLoopRun({
    id: loopRunId,
    task_id: taskId,
    spec_json: JSON.stringify(spec),
    max_iterations: spec.maxIterations,
    budget_json: spec.budget ? JSON.stringify(spec.budget) : null,
    group_id: groupId ?? null,
  });

  setRuntimeState(taskId, 'looping');

  writeLoopStatusFile(task.worktree!, {
    loopRunId: run.id,
    groupId: run.group_id,
    taskId,
    status: 'running',
    iteration: 0,
    maxIterations: spec.maxIterations,
    terminationReason: null,
    updatedAt: new Date().toISOString(),
  });

  const seeded = seedLearnings(task);
  await respawnAgentFresh(task, agent, {
    prompt: buildLoopPrompt(spec, run.id, null, seeded),
    env: loopAgentEnv(taskId, agent.hook_token),
  });

  logger.info({ task_id: taskId, loop_run_id: run.id, group_id: run.group_id }, 'loop: started');
  broadcast({ type: 'task:updated', payload: { taskId } });

  return run;
}

/**
 * Iteration boundary, called from the Stop hook when the task is looping.
 * Auto-commits, verifies, records the iteration, evaluates termination, and
 * either closes the loop or respawns the agent fresh for the next iteration.
 */
export async function handleLoopIterationBoundary(taskId: string, agentId: string): Promise<void> {
  const run = getActiveLoopRunForTask(taskId);
  if (!run) {
    logger.warn({ task_id: taskId, agent_id: agentId }, 'loop: no active run for looping task');
    return;
  }
  const task = getTask(taskId);
  const agent = getAgent(agentId);
  if (!task || !agent || !task.worktree) {
    logger.warn({ task_id: taskId, agent_id: agentId }, 'loop: task/agent/worktree missing');
    return;
  }

  const spec = JSON.parse(run.spec_json) as LoopSpec;
  const worktree = task.worktree;

  const shaFrom = await revParseHead(worktree);
  await commitAll(worktree, `loop(${run.id}): iteration ${run.iteration + 1}`);
  const shaTo = await revParseHead(worktree);

  const verify = await runVerify(worktree, spec.verify);

  const iteration = appendIteration(run.id, {
    sha_from: shaFrom,
    sha_to: shaTo,
    verify_passed: verify.passed ? 1 : 0,
  });

  const seeded = seedLearnings(task);
  setLearningsSeeded(iteration.id, seeded.length);

  const iterations = listIterationsForRun(run.id);
  const reason = evaluateTermination({
    run,
    spec,
    verifyPassed: verify.passed,
    iterationN: iteration.n,
    noProgressStreak: trailingNoProgressStreak(iterations),
    tokensUsed: sumTokens(iterations),
    now: Date.now(),
  });

  if (reason) {
    // Capture the agent's own emitted text BEFORE terminateLoopRun overwrites
    // loop_runs.termination_reason with the canonical short code below. Only
    // trust it for done/blocked/needs_human — those are the reasons that can
    // only fire because an emit set run.status THIS turn (resumeLoopRun
    // resets status, but not this column, so it can be stale for the other
    // three non-emit reasons — see engine.test.ts for why).
    const emitReason =
      reason === 'done' || reason === 'blocked' || reason === 'needs_human'
        ? run.termination_reason
        : null;

    terminateLoopRun(run.id, finalStatusFor(reason), reason);
    setRuntimeState(taskId, 'idle');
    writeLoopStatusFile(worktree, {
      loopRunId: run.id,
      groupId: run.group_id,
      taskId,
      status: finalStatusFor(reason),
      iteration: iteration.n,
      maxIterations: spec.maxIterations,
      terminationReason: reason,
      updatedAt: new Date().toISOString(),
    });
    logger.info(
      { task_id: taskId, loop_run_id: run.id, termination_reason: reason },
      'loop: terminated',
    );

    if (spec.runId) {
      const outcome = OUTCOME_FOR_REASON[reason];
      finishRun(spec.runId, {
        status: outcome,
        result: {
          outcome,
          summary: emitReason ?? `Loop stopped: ${reason} after ${iteration.n} iteration(s).`,
          links: task.pr_url ? [{ label: 'Pull request', url: task.pr_url }] : undefined,
        } satisfies RunResult,
      });
      logger.info(
        { task_id: taskId, loop_run_id: run.id, run_id: spec.runId, outcome },
        'loop: run finished',
      );
    }

    broadcast({ type: 'task:updated', payload: { taskId } });
    return;
  }

  resumeLoopRun(run.id);
  writeLoopStatusFile(worktree, {
    loopRunId: run.id,
    groupId: run.group_id,
    taskId,
    status: 'running',
    iteration: iteration.n,
    maxIterations: spec.maxIterations,
    terminationReason: null,
    updatedAt: new Date().toISOString(),
  });
  await respawnAgentFresh(task, agent, {
    prompt: buildLoopPrompt(spec, run.id, verify.passed ? null : verify.output, seeded),
    env: loopAgentEnv(taskId, agent.hook_token),
  });
}

/**
 * Startup crash-resume for a looping task whose tmux session died with the
 * server. Recovers controller state from the loop_run and kicks a FRESH
 * iteration (never `--resume`s the old harness session — a loop iteration is
 * fresh-context by design) into a brand-new tmux session, carrying the same
 * loopAgentEnv so `octomux emit` auth keeps working.
 *
 * Only gates on the run existing, not `run.status === 'running'`: a crash
 * right after an emit (which sets loop_runs.status to done/blocked/
 * needs_human *before* the Stop hook evaluates verify — see
 * getActiveLoopRunForTask's doc comment) must still resume. `runtime_state
 * === 'looping'`, already checked by the caller, is the authoritative "is
 * this loop still active" signal.
 *
 * ponytail: doesn't clean up orphaned user-terminal/viewer-session rows tied
 * to the dead session (prepareResumeSession does this for normal tasks) —
 * add if loop-crash-resume leaves visible terminal cruft.
 */
export async function resumeLoopOnStartup(task: Task): Promise<void> {
  const run = getActiveLoopRunForTask(task.id);
  if (!run) {
    logger.warn({ task_id: task.id }, 'loop: no loop_run to resume on startup');
    setRuntimeState(task.id, 'idle');
    return;
  }

  const agentRef = findFirstActiveAgent(task.id);
  const agent = agentRef ? getAgent(agentRef.id) : undefined;
  if (!agent) {
    logger.warn(
      { task_id: task.id, loop_run_id: run.id },
      'loop: no agent to resume loop on startup',
    );
    terminateLoopRun(run.id, 'needs_human', 'no_agent_on_startup');
    setRuntimeState(task.id, 'idle');
    return;
  }

  const spec = JSON.parse(run.spec_json) as LoopSpec;
  const seeded = seedLearnings(task);

  await respawnAgentFresh(task, agent, {
    prompt: buildLoopPrompt(spec, run.id, null, seeded),
    env: loopAgentEnv(task.id, agent.hook_token),
    fresh: true,
  });

  logger.info({ task_id: task.id, loop_run_id: run.id }, 'loop: resumed on startup');
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
}
