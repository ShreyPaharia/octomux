import { childLogger } from '../../logger.js';
import type { LoopRun, LoopIteration, LoopSpec } from '../../types.js';

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
  ];
}

/** Build the prompt for a loop iteration, pinning the loop run id (mirrors reviewTaskIdLines in review-tasks.ts). */
export function buildLoopPrompt(
  spec: LoopSpec,
  loopRunId: string,
  verifyFailureOutput?: string | null,
): string {
  const lines = [spec.prompt, '', ...loopRunIdLines(loopRunId)];
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

// logger is used by startLoop/handleLoopIterationBoundary, added in a later task.
void logger;
