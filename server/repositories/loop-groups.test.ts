import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  createLoopGroup,
  getLoopGroup,
  listLoopGroups,
  listLoopRunsForGroup,
  setJudgeRunning,
  recordJudgeResult,
} from './loop-groups.js';
import { createLoopRun } from './loop-runs.js';

describe('loop-groups repository', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('creates a loop group with judge_status defaulted to not_run', () => {
    const group = createLoopGroup({
      spec_json: '{}',
      n: 3,
      repo_path: '/repo',
      base_branch: 'main',
    });
    expect(group.judge_status).toBe('not_run');
    expect(group.winner_loop_run_id).toBeNull();
    expect(getLoopGroup(group.id)).toEqual(group);
  });

  it('lists loop_runs that share a group_id', () => {
    const db = createTestDb();
    const task1 = insertTask(db, { id: 'task-1' });
    const task2 = insertTask(db, { id: 'task-2' });
    const group = createLoopGroup({
      spec_json: '{}',
      n: 2,
      repo_path: '/repo',
      base_branch: 'main',
    });
    const run1 = createLoopRun({ task_id: task1.id, spec_json: '{}', group_id: group.id });
    const run2 = createLoopRun({ task_id: task2.id, spec_json: '{}', group_id: group.id });
    const other = createLoopRun({ task_id: task1.id, spec_json: '{}' });

    const runs = listLoopRunsForGroup(group.id);
    expect(runs.map((r) => r.id).sort()).toEqual([run1.id, run2.id].sort());
    expect(runs.map((r) => r.id)).not.toContain(other.id);
  });

  it('records a judge result exactly once, moving judge_status to done', () => {
    const db = createTestDb();
    const task = insertTask(db, { id: 'task-judge' });
    const group = createLoopGroup({
      spec_json: '{}',
      n: 2,
      repo_path: '/repo',
      base_branch: 'main',
    });
    const winner = createLoopRun({ task_id: task.id, spec_json: '{}', group_id: group.id });
    setJudgeRunning(group.id);
    expect(getLoopGroup(group.id)?.judge_status).toBe('running');

    recordJudgeResult(group.id, winner.id, 'Candidate 2 passed verify with cleaner diff.');
    const updated = getLoopGroup(group.id);
    expect(updated?.judge_status).toBe('done');
    expect(updated?.winner_loop_run_id).toBe(winner.id);
    expect(updated?.judge_rationale).toBe('Candidate 2 passed verify with cleaner diff.');
  });

  it('lists all groups ordered by created_at desc', () => {
    createLoopGroup({ spec_json: '{}', n: 1, repo_path: '/repo', base_branch: 'main' });
    createLoopGroup({ spec_json: '{}', n: 1, repo_path: '/repo', base_branch: 'main' });
    expect(listLoopGroups().length).toBe(2);
  });
});
