import { describe, it, expect } from 'vitest';
import { buildLoopPrompt, evaluateTermination } from './engine.js';
import type { LoopRun, LoopSpec } from '../../types.js';

function makeRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1',
    task_id: 't1',
    spec_json: '{}',
    status: 'running',
    iteration: 0,
    max_iterations: null,
    budget_json: null,
    termination_reason: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

const SPEC: LoopSpec = { prompt: 'do it', verify: 'true', maxIterations: 5 };

describe('buildLoopPrompt', () => {
  it('pins the loop run id and the emit instruction', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1');
    expect(prompt).toContain('do it');
    expect(prompt).toContain('Loop run id: run-1');
    expect(prompt).toContain('octomux emit --run run-1');
  });

  it('appends the failing verify output when provided', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1', 'test failed: assertion error');
    expect(prompt).toContain('test failed: assertion error');
  });

  it('omits the verify-failure section when there is none', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1', null);
    expect(prompt).not.toContain('verify command failed');
  });
});

describe('evaluateTermination', () => {
  const base = {
    spec: SPEC,
    verifyPassed: false,
    iterationN: 1,
    noProgressStreak: 0,
    tokensUsed: 0,
    now: Date.parse('2026-01-01T00:00:00Z'),
  };

  it('does not terminate on a plain running iteration', () => {
    expect(evaluateTermination({ ...base, run: makeRun() })).toBeNull();
  });

  it('terminates done only when status is done AND verify passed', () => {
    expect(
      evaluateTermination({ ...base, run: makeRun({ status: 'done' }), verifyPassed: false }),
    ).toBeNull();
    expect(
      evaluateTermination({ ...base, run: makeRun({ status: 'done' }), verifyPassed: true }),
    ).toBe('done');
  });

  it('terminates blocked/needs_human regardless of verify', () => {
    expect(evaluateTermination({ ...base, run: makeRun({ status: 'blocked' }) })).toBe('blocked');
    expect(evaluateTermination({ ...base, run: makeRun({ status: 'needs_human' }) })).toBe(
      'needs_human',
    );
  });

  it('terminates max_iterations once iterationN reaches spec.maxIterations', () => {
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 5 })).toBe(
      'max_iterations',
    );
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 4 })).toBeNull();
  });

  it('terminates budget on token ceiling', () => {
    const spec: LoopSpec = { ...SPEC, budget: { tokens: 1000 } };
    expect(evaluateTermination({ ...base, spec, run: makeRun(), tokensUsed: 1000 })).toBe(
      'budget',
    );
    expect(evaluateTermination({ ...base, spec, run: makeRun(), tokensUsed: 999 })).toBeNull();
  });

  it('terminates budget on elapsed wall-clock time', () => {
    const spec: LoopSpec = { ...SPEC, budget: { timeMs: 60_000 } };
    const run = makeRun({ created_at: '2026-01-01 00:00:00' });
    const justUnder = Date.parse('2026-01-01T00:00:59Z');
    const atLimit = Date.parse('2026-01-01T00:01:00Z');
    expect(evaluateTermination({ ...base, spec, run, now: justUnder })).toBeNull();
    expect(evaluateTermination({ ...base, spec, run, now: atLimit })).toBe('budget');
  });

  it('terminates no_progress once the streak reaches spec.noProgress.afterIters', () => {
    const spec: LoopSpec = { ...SPEC, noProgress: { afterIters: 3 } };
    expect(
      evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 3 }),
    ).toBe('no_progress');
    expect(
      evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 2 }),
    ).toBeNull();
  });

  it('skips no_progress evaluation when spec.noProgress is not set', () => {
    expect(
      evaluateTermination({ ...base, run: makeRun(), noProgressStreak: 999 }),
    ).toBeNull();
  });
});
