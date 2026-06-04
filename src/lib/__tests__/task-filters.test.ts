import { describe, it, expect } from 'vitest';
import { isRegularTask, regularTasksOnly } from '../task-filters';

describe('task-filters', () => {
  it('excludes auto_review tasks', () => {
    expect(isRegularTask({ source: null })).toBe(true);
    expect(isRegularTask({ source: 'auto_review' })).toBe(false);
  });

  it('regularTasksOnly filters list', () => {
    const out = regularTasksOnly([
      { source: null },
      { source: 'auto_review' },
      { source: null },
    ]);
    expect(out).toHaveLength(2);
  });
});
