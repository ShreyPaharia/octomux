import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, DEFAULTS } from '../../test-helpers.js';
import type { LoopRun, LoopSpec } from '../../types.js';

vi.mock('../git.js', () => ({
  revParseHead: vi.fn(),
  commitAll: vi.fn(async () => true),
}));
vi.mock('./verify.js', () => ({
  runVerify: vi.fn(),
}));
vi.mock('../lifecycle/respawn-agent.js', () => ({
  respawnAgentFresh: vi.fn(async (_task, agent) => agent),
}));
vi.mock('../../events.js', () => ({
  broadcast: vi.fn(),
}));
vi.mock('../../hook-base-url.js', () => ({
  hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777'),
}));

const { buildLoopPrompt, evaluateTermination, startLoop, handleLoopIterationBoundary } =
  await import('./engine.js');
const { revParseHead, commitAll } = await import('../git.js');
const { runVerify } = await import('./verify.js');
const { respawnAgentFresh } = await import('../lifecycle/respawn-agent.js');
const { getLoopRun, listIterationsForRun, recordEmit } = await import(
  '../../repositories/loop-runs.js'
);

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

const LOOP_SPEC: LoopSpec = { prompt: 'fix the bug', verify: 'bun run test', maxIterations: 5 };

describe('startLoop', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  it('creates a running loop_run, flips runtime_state to looping, and respawns fresh', async () => {
    const run = await startLoop('t1', LOOP_SPEC);

    expect(run.task_id).toBe('t1');
    expect(run.status).toBe('running');

    const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(task.runtime_state).toBe('looping');

    expect(respawnAgentFresh).toHaveBeenCalledTimes(1);
    const [, , opts] = vi.mocked(respawnAgentFresh).mock.calls[0];
    expect(opts?.prompt).toContain(`Loop run id: ${run.id}`);
    expect(opts?.env).toMatchObject({ OCTOMUX_ACTION_TOKEN: 'tok-1', OCTOMUX_TASK_ID: 't1' });
  });

  it('throws when the task has no active agent', async () => {
    db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = 'a1'`).run();
    await expect(startLoop('t1', LOOP_SPEC)).rejects.toThrow(/no active agent/);
  });
});

describe('handleLoopIterationBoundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  it('respawns while verify fails, terminates done once verify passes', async () => {
    let sha = 0;
    vi.mocked(revParseHead).mockImplementation(async () => `sha${sha++}`);
    vi.mocked(runVerify)
      .mockResolvedValueOnce({ passed: false, output: 'fail 1' })
      .mockResolvedValueOnce({ passed: false, output: 'fail 2' })
      .mockResolvedValueOnce({ passed: true, output: 'ok' });

    const run = await startLoop('t1', LOOP_SPEC);

    recordEmit(run.id, { status: 'done', reason: 'iter1' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(2); // startLoop's + this one

    recordEmit(run.id, { status: 'done', reason: 'iter2' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(3);

    recordEmit(run.id, { status: 'done', reason: 'iter3' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(3); // not called again — terminated

    const finalRun = getLoopRun(run.id);
    expect(finalRun?.status).toBe('done');
    expect(finalRun?.termination_reason).toBe('done');

    const iterations = listIterationsForRun(run.id);
    expect(iterations).toHaveLength(3);
    expect(iterations.every((it) => it.verify_passed !== null)).toBe(true);

    const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(task.runtime_state).toBe('idle');
  });

  it('terminates max_iterations once the cap is hit, without waiting for a done emit', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });

    const run = await startLoop('t1', { ...LOOP_SPEC, maxIterations: 2 });

    await handleLoopIterationBoundary('t1', 'a1');
    expect(getLoopRun(run.id)?.termination_reason).toBeNull();

    await handleLoopIterationBoundary('t1', 'a1');
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.termination_reason).toBe('max_iterations');
    expect(finalRun?.status).toBe('needs_human');
  });

  it('terminates no_progress after N consecutive no-op commits', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'same-sha-every-time');
    vi.mocked(commitAll).mockResolvedValue(false); // nothing to commit
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'nothing changed' });

    const run = await startLoop('t1', {
      ...LOOP_SPEC,
      maxIterations: 10,
      noProgress: { afterIters: 2 },
    });

    await handleLoopIterationBoundary('t1', 'a1');
    expect(getLoopRun(run.id)?.termination_reason).toBeNull();

    await handleLoopIterationBoundary('t1', 'a1');
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.termination_reason).toBe('no_progress');
  });

  it('checks budget before respawning', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => `sha-${Math.random()}`);
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still working' });

    const run = await startLoop('t1', { ...LOOP_SPEC, maxIterations: 100, budget: { timeMs: 1 } });
    db.prepare(`UPDATE loop_runs SET created_at = datetime('now', '-1 hour') WHERE id = ?`).run(
      run.id,
    );

    const callsBefore = vi.mocked(respawnAgentFresh).mock.calls.length;
    await handleLoopIterationBoundary('t1', 'a1');

    expect(vi.mocked(respawnAgentFresh).mock.calls.length).toBe(callsBefore); // no new respawn
    expect(getLoopRun(run.id)?.termination_reason).toBe('budget');
  });
});
