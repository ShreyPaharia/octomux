import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import {
  addLearning,
  touchLearning,
  listLearningsForRepo,
  deleteLearning,
} from './review-learnings.js';

describe('review-learnings', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('adds a learning row with usage_count=0', () => {
    const row = addLearning({ repo_path: '/repos/foo', why: "don't memoize side-effects" });
    expect(row.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(row.usage_count).toBe(0);
    expect(row.last_used_at).toBeNull();
  });

  it('touchLearning increments usage_count and updates last_used_at', () => {
    const row = addLearning({ repo_path: '/r', why: 'w' });
    touchLearning(row.id);
    touchLearning(row.id);
    const all = listLearningsForRepo('/r');
    expect(all[0].usage_count).toBe(2);
    expect(all[0].last_used_at).not.toBeNull();
  });

  it('listLearningsForRepo returns most-recently-used first, then unused by created_at desc', () => {
    const a = addLearning({ repo_path: '/r', why: 'a' });
    const b = addLearning({ repo_path: '/r', why: 'b' });
    addLearning({ repo_path: '/r', why: 'c' });
    touchLearning(b.id);
    touchLearning(a.id);
    const ordered = listLearningsForRepo('/r').map((l) => l.why);
    expect(ordered[0]).toBe('a');
    expect(ordered[1]).toBe('b');
    expect(ordered[2]).toBe('c');
  });

  it('caps list to limit (50 default)', () => {
    for (let i = 0; i < 60; i++) addLearning({ repo_path: '/r', why: `w${i}` });
    expect(listLearningsForRepo('/r').length).toBe(50);
    expect(listLearningsForRepo('/r', { limit: 5 }).length).toBe(5);
  });

  it('deleteLearning removes the row', () => {
    const row = addLearning({ repo_path: '/r', why: 'x' });
    deleteLearning(row.id);
    expect(listLearningsForRepo('/r').length).toBe(0);
  });

  it('scopes by repo_path', () => {
    addLearning({ repo_path: '/r1', why: 'a' });
    addLearning({ repo_path: '/r2', why: 'b' });
    expect(listLearningsForRepo('/r1').map((l) => l.why)).toEqual(['a']);
    expect(listLearningsForRepo('/r2').map((l) => l.why)).toEqual(['b']);
  });
});
