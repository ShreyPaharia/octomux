import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  createLoopRun,
  getLoopRun,
  appendIteration,
  recordEmit,
  getActiveLoopRunForTask,
  terminateLoopRun,
  resumeLoopRun,
} from './loop-runs.js';

const TASK_ID = 't_task1';

function insertTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
     VALUES (?, 'x', '', 'looping', 'backlog', 'loop')`,
  ).run(TASK_ID);
}

describe('loop-runs', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db);
  });

  it('createLoopRun round-trips', () => {
    const run = createLoopRun({
      task_id: TASK_ID,
      spec_json: '{"goal":"fix bug"}',
      max_iterations: 5,
      budget_json: '{"tokens":100000}',
    });

    expect(run.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(run.task_id).toBe(TASK_ID);
    expect(run.spec_json).toBe('{"goal":"fix bug"}');
    expect(run.status).toBe('running');
    expect(run.iteration).toBe(0);
    expect(run.max_iterations).toBe(5);
    expect(run.budget_json).toBe('{"tokens":100000}');
    expect(run.termination_reason).toBeNull();

    const fetched = getLoopRun(run.id);
    expect(fetched).toEqual(run);
  });

  it('getLoopRun returns undefined for an unknown id', () => {
    expect(getLoopRun('nope')).toBeUndefined();
  });

  it('appendIteration increments n starting at 1', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });

    const first = appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });
    expect(first.n).toBe(1);
    expect(first.loop_run_id).toBe(run.id);
    expect(first.sha_from).toBe('a1');
    expect(first.sha_to).toBe('a2');

    const second = appendIteration(run.id, { sha_from: 'a2', sha_to: 'a3', tokens: 500 });
    expect(second.n).toBe(2);
    expect(second.tokens).toBe(500);

    const updatedRun = getLoopRun(run.id);
    expect(updatedRun?.iteration).toBe(2);
  });

  it('recordEmit updates run status + latest iteration emit fields', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });
    const latest = appendIteration(run.id, { sha_from: 'a2', sha_to: 'a3' });

    recordEmit(run.id, { status: 'done', reason: 'all tests pass' });

    const updatedRun = getLoopRun(run.id);
    expect(updatedRun?.status).toBe('done');
    expect(updatedRun?.termination_reason).toBe('all tests pass');

    const iterations = db.prepare(`SELECT * FROM loop_iterations WHERE id = ?`).get(latest.id) as {
      emit_status: string;
      emit_reason: string;
    };
    expect(iterations.emit_status).toBe('done');
    expect(iterations.emit_reason).toBe('all tests pass');
  });

  it('getActiveLoopRunForTask returns the run for a task', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
  });

  it('getActiveLoopRunForTask still finds a run after an emit flips its status (not status-filtered)', () => {
    // recordEmit (the agent's `octomux emit` callback) flips status to
    // 'done'/'blocked'/'needs_human' BEFORE the Stop hook that reports the
    // same turn's end ever fires. getActiveLoopRunForTask must still find the
    // run in that window so the engine can process the emit against it —
    // tasks.runtime_state is the authoritative "still looping" signal, not
    // this column. See getActiveLoopRunForTask's doc comment.
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    recordEmit(run.id, { status: 'done', reason: 'agent thinks it is done' });
    expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
  });

  it('getActiveLoopRunForTask still returns the run after engine termination (most-recent-for-task lookup)', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    terminateLoopRun(run.id, 'needs_human', 'max_iterations');
    expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
  });

  it('terminateLoopRun sets status and a canonical termination_reason', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    recordEmit(run.id, { status: 'done', reason: 'agent free-text reason' });

    terminateLoopRun(run.id, 'done', 'done');

    const updated = getLoopRun(run.id);
    expect(updated?.status).toBe('done');
    expect(updated?.termination_reason).toBe('done');
  });

  it('resumeLoopRun resets status back to running', () => {
    const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
    recordEmit(run.id, { status: 'done', reason: 'verify failed after this' });

    resumeLoopRun(run.id);

    expect(getLoopRun(run.id)?.status).toBe('running');
    expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
  });
});
