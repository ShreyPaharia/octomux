import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, DEFAULTS } from '../../test-helpers.js';
import type { LoopRun, LoopSpec, Task, RunResult } from '../../types.js';

vi.mock('../git.js', () => ({
  revParseHead: vi.fn(),
  commitAll: vi.fn(async () => true),
  diffNameOnly: vi.fn(async () => []),
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

const {
  buildLoopPrompt,
  evaluateTermination,
  startLoop,
  handleLoopIterationBoundary,
  resumeLoopOnStartup,
} = await import('./engine.js');
const { revParseHead, commitAll, diffNameOnly } = await import('../git.js');
const { runVerify } = await import('./verify.js');
const { respawnAgentFresh } = await import('../lifecycle/respawn-agent.js');
const { getLoopRun, listIterationsForRun, recordEmit, createLoopRun } =
  await import('../../repositories/loop-runs.js');
const { createLoopGroup } = await import('../../repositories/loop-groups.js');
const { insertRun, getRun } = await import('../../repositories/runs.js');

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
    group_id: null,
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

  it('tells the agent to read the loop playbook first', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1');
    expect(prompt).toContain('.octomux/loop-playbook.md');
    expect(prompt).toMatch(/read it first/);
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
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 5 })).toBe('max_iterations');
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 4 })).toBeNull();
  });

  it('terminates budget on token ceiling', () => {
    const spec: LoopSpec = { ...SPEC, budget: { tokens: 1000 } };
    expect(evaluateTermination({ ...base, spec, run: makeRun(), tokensUsed: 1000 })).toBe('budget');
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
    expect(evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 3 })).toBe(
      'no_progress',
    );
    expect(evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 2 })).toBeNull();
  });

  it('skips no_progress evaluation when spec.noProgress is not set', () => {
    expect(evaluateTermination({ ...base, run: makeRun(), noProgressStreak: 999 })).toBeNull();
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

  it('passes groupId through to createLoopRun when best-of-N launches this candidate', async () => {
    const group = createLoopGroup({
      spec_json: '{}',
      n: 3,
      repo_path: '/repo',
      base_branch: 'main',
    });
    const run = await startLoop('t1', LOOP_SPEC, group.id);
    expect(run.group_id).toBe(group.id);
  });

  it('defaults group_id to null for a plain single loop', async () => {
    const run = await startLoop('t1', LOOP_SPEC);
    expect(run.group_id).toBeNull();
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

  it('does not terminate done when run.status is done but verify fails — respawns for another iteration instead', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => `sha-${Math.random()}`);
    vi.mocked(runVerify).mockResolvedValueOnce({ passed: false, output: 'still failing' });

    const run = await startLoop('t1', LOOP_SPEC);
    const respawnCallsBefore = vi.mocked(respawnAgentFresh).mock.calls.length;

    recordEmit(run.id, { status: 'done', reason: 'looks done but verify disagrees' });
    await handleLoopIterationBoundary('t1', 'a1');

    expect(vi.mocked(respawnAgentFresh).mock.calls.length).toBe(respawnCallsBefore + 1);
    // resumeLoopRun resets status back to 'running' — the emit's 'done' status
    // never survives evaluateTermination when verify failed.
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.status).toBe('running');
  });

  it('terminates done when run.status is done and verify passes', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => `sha-${Math.random()}`);
    vi.mocked(runVerify).mockResolvedValueOnce({ passed: true, output: 'ok' });

    const run = await startLoop('t1', LOOP_SPEC);
    const respawnCallsBefore = vi.mocked(respawnAgentFresh).mock.calls.length;

    recordEmit(run.id, { status: 'done', reason: 'iter1' });
    await handleLoopIterationBoundary('t1', 'a1');

    expect(vi.mocked(respawnAgentFresh).mock.calls.length).toBe(respawnCallsBefore); // no further respawn
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.status).toBe('done');
    expect(finalRun?.termination_reason).toBe('done');
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

describe('loop playbook', () => {
  let db: Database.Database;
  let worktree: string;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-loop-playbook-'));
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running', worktree });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  function readPlaybook(): string {
    return fs.readFileSync(path.join(worktree, '.octomux', 'loop-playbook.md'), 'utf-8');
  }

  it('appends a PASS entry with changed files and no verify output on success', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(diffNameOnly).mockResolvedValueOnce(['src/foo.ts', 'src/bar.ts']);
    vi.mocked(runVerify).mockResolvedValueOnce({ passed: true, output: 'all good' });

    const run = await startLoop('t1', LOOP_SPEC);
    recordEmit(run.id, { status: 'done', reason: 'iter1' });
    await handleLoopIterationBoundary('t1', 'a1');

    const playbook = readPlaybook();
    expect(playbook).toContain('## Iteration 1 — verify PASS');
    expect(playbook).toContain('src/foo.ts, src/bar.ts');
    expect(playbook).not.toContain('verify output');
  });

  it('appends a FAIL entry including the verify output', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(diffNameOnly).mockResolvedValueOnce(['src/foo.ts']);
    vi.mocked(runVerify).mockResolvedValueOnce({
      passed: false,
      output: 'assertion failed: x != y',
    });

    await startLoop('t1', LOOP_SPEC);
    await handleLoopIterationBoundary('t1', 'a1');

    const playbook = readPlaybook();
    expect(playbook).toContain('## Iteration 1 — verify FAIL');
    expect(playbook).toContain('verify output: assertion failed: x != y');
  });

  it('accumulates entries across iterations instead of overwriting', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(diffNameOnly).mockResolvedValue([]);
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });

    await startLoop('t1', LOOP_SPEC);
    await handleLoopIterationBoundary('t1', 'a1');
    await handleLoopIterationBoundary('t1', 'a1');

    const playbook = readPlaybook();
    expect(playbook).toContain('## Iteration 1 — verify FAIL');
    expect(playbook).toContain('## Iteration 2 — verify FAIL');
  });
});

describe('loop status file', () => {
  let db: Database.Database;
  let worktree: string;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-loop-status-'));
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running', worktree });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  function readStatus(): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(worktree, '.octomux', 'loop-status.json'), 'utf-8'),
    );
  }

  it('startLoop writes an initial running status file with the group id', async () => {
    const group = createLoopGroup({
      spec_json: '{}',
      n: 3,
      repo_path: '/repo',
      base_branch: 'main',
    });
    const run = await startLoop('t1', LOOP_SPEC, group.id);

    const status = readStatus();
    expect(status).toMatchObject({
      loopRunId: run.id,
      groupId: group.id,
      taskId: 't1',
      status: 'running',
      iteration: 0,
      maxIterations: LOOP_SPEC.maxIterations,
      terminationReason: null,
    });
  });

  it('handleLoopIterationBoundary updates the status file on the resume path', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => `sha-${Math.random()}`);
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });

    await startLoop('t1', LOOP_SPEC);
    await handleLoopIterationBoundary('t1', 'a1');

    const status = readStatus();
    expect(status).toMatchObject({ status: 'running', iteration: 1, terminationReason: null });
  });

  it('handleLoopIterationBoundary updates the status file on the terminate path', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(runVerify).mockResolvedValueOnce({ passed: true, output: 'ok' });

    const run = await startLoop('t1', LOOP_SPEC);
    recordEmit(run.id, { status: 'done', reason: 'iter1' });
    await handleLoopIterationBoundary('t1', 'a1');

    const status = readStatus();
    expect(status).toMatchObject({ status: 'done', iteration: 1, terminationReason: 'done' });
  });
});

describe('resumeLoopOnStartup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'looping' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  it('resumes an active loop_run via a fresh respawn, not --resume', async () => {
    const run = createLoopRun({
      task_id: 't1',
      spec_json: JSON.stringify(LOOP_SPEC),
      max_iterations: LOOP_SPEC.maxIterations,
    });
    const task = { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'looping' } as Task;

    await resumeLoopOnStartup(task);

    expect(respawnAgentFresh).toHaveBeenCalledTimes(1);
    const [, , opts] = vi.mocked(respawnAgentFresh).mock.calls[0];
    expect(opts?.fresh).toBe(true);
    expect(opts?.prompt).toContain(`Loop run id: ${run.id}`);
    expect(opts?.env).toMatchObject({ OCTOMUX_ACTION_TOKEN: 'tok-1', OCTOMUX_TASK_ID: 't1' });
  });

  it('idles the task when there is no active loop_run to resume', async () => {
    const task = { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'looping' } as Task;

    await resumeLoopOnStartup(task);

    expect(respawnAgentFresh).not.toHaveBeenCalled();
    const updated = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(updated.runtime_state).toBe('idle');
  });

  it("still resumes when the run's last-known status is a terminal emit status (crash right after emit, before the Stop hook processed it)", async () => {
    // recordEmit sets loop_runs.status to done/blocked/needs_human *before*
    // the Stop hook evaluates verify and actually terminates the run — a
    // crash in that window must not be mistaken for "already terminated".
    const run = createLoopRun({ task_id: 't1', spec_json: JSON.stringify(LOOP_SPEC) });
    recordEmit(run.id, { status: 'done', reason: 'looks done' });
    const task = { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'looping' } as Task;

    await resumeLoopOnStartup(task);

    expect(respawnAgentFresh).toHaveBeenCalledTimes(1);
  });
});

describe('run-result envelope on termination', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
    let sha = 0;
    vi.mocked(revParseHead).mockImplementation(async () => `sha${sha++}`);
    vi.mocked(commitAll).mockResolvedValue(true);
    vi.mocked(diffNameOnly).mockResolvedValue([]);
  });

  type Case = {
    reason: string;
    expectedOutcome: RunResult['outcome'];
    specOverrides?: Partial<LoopSpec>;
    drive: (loopRunId: string) => Promise<void>;
  };

  const CASES: Case[] = [
    {
      reason: 'done',
      expectedOutcome: 'done',
      drive: async (loopRunId) => {
        vi.mocked(runVerify).mockResolvedValueOnce({ passed: true, output: 'ok' });
        recordEmit(loopRunId, { status: 'done', reason: 'All tests pass now.' });
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
    {
      reason: 'blocked',
      expectedOutcome: 'blocked',
      drive: async (loopRunId) => {
        vi.mocked(runVerify).mockResolvedValueOnce({ passed: false, output: 'n/a' });
        recordEmit(loopRunId, { status: 'blocked', reason: 'Need clarification on scope.' });
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
    {
      reason: 'needs_human',
      expectedOutcome: 'blocked',
      drive: async (loopRunId) => {
        vi.mocked(runVerify).mockResolvedValueOnce({ passed: false, output: 'n/a' });
        recordEmit(loopRunId, { status: 'needs_human', reason: 'Requires human review.' });
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
    {
      reason: 'max_iterations',
      expectedOutcome: 'failed',
      specOverrides: { maxIterations: 1 },
      drive: async () => {
        vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
    {
      reason: 'budget',
      expectedOutcome: 'failed',
      specOverrides: { maxIterations: 100, budget: { timeMs: 1 } },
      drive: async (loopRunId) => {
        vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });
        db.prepare(`UPDATE loop_runs SET created_at = datetime('now', '-1 hour') WHERE id = ?`).run(
          loopRunId,
        );
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
    {
      reason: 'no_progress',
      expectedOutcome: 'failed',
      specOverrides: { maxIterations: 100, noProgress: { afterIters: 1 } },
      drive: async () => {
        vi.mocked(revParseHead).mockImplementation(async () => 'same-sha-every-time');
        vi.mocked(commitAll).mockResolvedValue(false);
        vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'nothing changed' });
        await handleLoopIterationBoundary('t1', 'a1');
      },
    },
  ];

  it.each(CASES)(
    'termination reason $reason finishes the run as $expectedOutcome',
    async ({ expectedOutcome, specOverrides, drive }) => {
      const runsRow = insertRun({ workflowKind: 'doc-drift', trigger: 'cron', taskId: 't1' });
      const loopRunId = 'loop-run-1';
      await startLoop(
        't1',
        { ...LOOP_SPEC, ...specOverrides, runId: runsRow.id },
        undefined,
        loopRunId,
      );

      await drive(loopRunId);

      const finished = getRun(runsRow.id);
      expect(finished?.status).not.toBe('running');
      expect(finished?.ended_at).not.toBeNull();
      const result = JSON.parse(finished!.result_json!) as RunResult;
      expect(result.outcome).toBe(expectedOutcome);
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    },
  );

  it('uses the agent-emitted reason text as the summary for done', async () => {
    const runsRow = insertRun({ workflowKind: 'doc-drift', trigger: 'cron', taskId: 't1' });
    const loopRunId = 'loop-run-2';
    await startLoop('t1', { ...LOOP_SPEC, runId: runsRow.id }, undefined, loopRunId);

    vi.mocked(runVerify).mockResolvedValueOnce({ passed: true, output: 'ok' });
    recordEmit(loopRunId, { status: 'done', reason: 'Fixed the flaky test and verified locally.' });
    await handleLoopIterationBoundary('t1', 'a1');

    const finished = getRun(runsRow.id);
    const result = JSON.parse(finished!.result_json!) as RunResult;
    expect(result.summary).toBe('Fixed the flaky test and verified locally.');
  });

  it('falls back to a mechanical summary for max_iterations, which never has an agent emit', async () => {
    const runsRow = insertRun({ workflowKind: 'doc-drift', trigger: 'cron', taskId: 't1' });
    const loopRunId = 'loop-run-3';
    await startLoop(
      't1',
      { ...LOOP_SPEC, maxIterations: 1, runId: runsRow.id },
      undefined,
      loopRunId,
    );

    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });
    await handleLoopIterationBoundary('t1', 'a1');

    const finished = getRun(runsRow.id);
    const result = JSON.parse(finished!.result_json!) as RunResult;
    expect(result.summary).toContain('max_iterations');
  });

  it('does not touch the runs table when the loop spec carries no runId', async () => {
    await startLoop('t1', { ...LOOP_SPEC, maxIterations: 1 });

    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });
    // Must not throw for a spec with no runId (loops created via POST /api/loops today).
    await expect(handleLoopIterationBoundary('t1', 'a1')).resolves.toBeUndefined();
  });
});
