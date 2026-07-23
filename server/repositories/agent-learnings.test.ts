import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask, DEFAULTS } from '../test-helpers.js';
import { createLoopRun, appendIteration, setLearningsSeeded } from './loop-runs.js';
import {
  addLearning,
  listForRead,
  touchLearning,
  deleteLearning,
  listForDigest,
  listBenefit,
  laneFor,
  SHARED_LANE,
  getLearning,
  supersedeLearning,
  searchForRead,
} from './agent-learnings.js';

describe('agent-learnings', () => {
  beforeEach(() => createTestDb());

  it('adds a learning and dedups normalized-identical lessons in the same lane', () => {
    const a = addLearning({
      repo_path: '/r',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'Use default: mocked',
      evidence: 'setup.ts',
    });
    expect(a).not.toBeNull();
    const dup = addLearning({
      repo_path: '/r',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: '  use default: mocked ',
      evidence: 'x',
    });
    expect(dup).toBeNull();
    expect(listForRead('/r', 'loop:x').length).toBe(1);
  });

  it('listForRead returns shared + own lane only, capped, recency/usage first', () => {
    addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'shared-1' });
    addLearning({ repo_path: '/r', lane: 'loop:mine', trigger: 't', lesson: 'mine-1' });
    addLearning({ repo_path: '/r', lane: 'loop:other', trigger: 't', lesson: 'other-1' });
    const lessons = listForRead('/r', 'loop:mine')
      .map((l) => l.lesson)
      .sort();
    expect(lessons).toEqual(['mine-1', 'shared-1']);
  });

  it('touchLearning increments usage_count and sets last_used_at', () => {
    const a = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'x' })!;
    touchLearning(a.id);
    touchLearning(a.id);
    expect(listForRead('/r', 'loop:x')[0].usage_count).toBe(2);
  });

  it('laneFor: schedule id when scheduled, else loop:<task-id>', () => {
    expect(laneFor({ id: 'tk1', schedule_id: 'sch9' })).toBe('schedule:sch9');
    expect(laneFor({ id: 'tk1', schedule_id: null })).toBe('loop:tk1');
  });

  it('listForDigest splits recent additions from unused rows', () => {
    const used = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'used' })!;
    addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'never-used' });
    touchLearning(used.id);
    const d = listForDigest('/r', '1970-01-01 00:00:00');
    expect(d.additions.length).toBe(2);
    expect(d.unused.map((l) => l.lesson)).toContain('never-used');
  });

  it('deleteLearning removes the row', () => {
    const a = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'x' })!;
    deleteLearning(a.id);
    expect(listForRead('/r', 'loop:x').length).toBe(0);
  });

  describe('getLearning / supersedeLearning', () => {
    it('getLearning returns the row by id, undefined when missing', () => {
      const a = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'x' })!;
      expect(getLearning(a.id)?.id).toBe(a.id);
      expect(getLearning('nope')).toBeUndefined();
    });

    it('supersedeLearning sets superseded_at + superseded_reason and hides the row from reads', () => {
      const a = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'x' })!;
      expect(getLearning(a.id)?.superseded_at).toBeNull();

      supersedeLearning(a.id, 'no longer true — repo moved to bun');

      const row = getLearning(a.id)!;
      expect(row.superseded_at).toBeTruthy();
      expect(row.superseded_reason).toBe('no longer true — repo moved to bun');
      expect(listForRead('/r', 'loop:x')).toEqual([]);
      expect(searchForRead('/r', 'loop:x', 'x')).toEqual([]);
    });

    it('is reversible in the sense that the row still exists (soft, not hard delete)', () => {
      const a = addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'x' })!;
      supersedeLearning(a.id, 'stale');
      expect(getLearning(a.id)).toBeDefined();
    });
  });

  it('listForDigest also returns superseded rows as removal candidates', () => {
    const a = addLearning({
      repo_path: '/r',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'now-false',
    })!;
    addLearning({ repo_path: '/r', lane: SHARED_LANE, trigger: 't', lesson: 'still-true' });
    supersedeLearning(a.id, 'contradicted by new evidence');

    const d = listForDigest('/r', '1970-01-01 00:00:00');
    expect(d.superseded.map((l) => l.lesson)).toEqual(['now-false']);
    expect(d.superseded[0].superseded_reason).toBe('contradicted by new evidence');
  });

  describe('listBenefit', () => {
    const REPO_PATH = '/repo/benefit';

    function seedIteration(
      taskId: string,
      seeded: number | null,
      verifyPassed: number | null,
    ): void {
      insertTask(db, {
        ...DEFAULTS.runningTask,
        id: taskId,
        repo_path: REPO_PATH,
        worktree: REPO_PATH,
      });
      const run = createLoopRun({ task_id: taskId, spec_json: '{}' });
      const iteration = appendIteration(run.id, { verify_passed: verifyPassed });
      if (seeded !== null) setLearningsSeeded(iteration.id, seeded);
    }

    let db: ReturnType<typeof createTestDb>;

    beforeEach(() => {
      db = createTestDb();
    });

    it('computes seeded vs unseeded pass rates from loop_iterations joined through loop_runs/tasks/worktrees', () => {
      // seeded: 2 iterations, 1 pass -> 0.5
      seedIteration('tk1', 2, 1);
      seedIteration('tk2', 3, 0);
      // unseeded: 2 iterations, both pass -> 1.0
      seedIteration('tk3', 0, 1);
      seedIteration('tk4', null, 1);

      const benefit = listBenefit(REPO_PATH);
      expect(benefit.seededN).toBe(2);
      expect(benefit.unseededN).toBe(2);
      expect(benefit.seededPassRate).toBeCloseTo(0.5);
      expect(benefit.unseededPassRate).toBeCloseTo(1);
    });

    it('guards divide-by-zero when there is no data for the repo', () => {
      const benefit = listBenefit('/no/such/repo');
      expect(benefit).toEqual({ seededN: 0, unseededN: 0, seededPassRate: 0, unseededPassRate: 0 });
    });
  });
});
