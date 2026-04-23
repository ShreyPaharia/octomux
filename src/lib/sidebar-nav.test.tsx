import { describe, it, expect, beforeEach } from 'vitest';
import {
  currentTaskIdFromPath,
  getNextSessionId,
  readCollapsedGroups,
  visibleSessionIds,
  GROUP_COLLAPSE_PREFIX,
} from './sidebar-nav';
import type { SidebarGroup } from './sidebar-utils';

const group = (key: string, ids: string[]): SidebarGroup => ({
  key,
  repo: key,
  items: ids.map((id) => ({
    id,
    title: id,
    status: 'running',
    derivedStatus: null,
    runMode: 'new',
    repoPath: key,
  })),
});

describe('currentTaskIdFromPath', () => {
  it.each([
    { path: '/tasks/abc', expected: 'abc' },
    { path: '/tasks/abc/something', expected: 'abc' },
    { path: '/', expected: null },
    { path: '/tasks', expected: null },
    { path: '/orchestrator', expected: null },
  ])('$path → $expected', ({ path, expected }) => {
    expect(currentTaskIdFromPath(path)).toBe(expected);
  });
});

describe('visibleSessionIds', () => {
  it('returns every id when no group collapsed', () => {
    const groups = [group('r1', ['a', 'b']), group('r2', ['c'])];
    expect(visibleSessionIds(groups, {})).toEqual(['a', 'b', 'c']);
  });

  it('skips items in collapsed groups', () => {
    const groups = [group('r1', ['a', 'b']), group('r2', ['c'])];
    expect(visibleSessionIds(groups, { r1: true })).toEqual(['c']);
  });

  it('returns empty when every group collapsed', () => {
    const groups = [group('r1', ['a']), group('r2', ['b'])];
    expect(visibleSessionIds(groups, { r1: true, r2: true })).toEqual([]);
  });
});

describe('getNextSessionId', () => {
  const ids = ['a', 'b', 'c'];

  it.each([
    { name: 'next from a', current: 'a', dir: 'next', expected: 'b' },
    { name: 'next from c wraps to a', current: 'c', dir: 'next', expected: 'a' },
    { name: 'prev from a wraps to c', current: 'a', dir: 'prev', expected: 'c' },
    { name: 'prev from b → a', current: 'b', dir: 'prev', expected: 'a' },
    { name: 'no current + next → first', current: null, dir: 'next', expected: 'a' },
    { name: 'no current + prev → last', current: null, dir: 'prev', expected: 'c' },
    { name: 'unknown current + next → first', current: 'ghost', dir: 'next', expected: 'a' },
    { name: 'unknown current + prev → last', current: 'ghost', dir: 'prev', expected: 'c' },
  ] as const)('$name', ({ current, dir, expected }) => {
    expect(getNextSessionId(ids, current, dir)).toBe(expected);
  });

  it('returns null when list is empty', () => {
    expect(getNextSessionId([], 'x', 'next')).toBeNull();
    expect(getNextSessionId([], null, 'prev')).toBeNull();
  });
});

describe('readCollapsedGroups', () => {
  beforeEach(() => localStorage.clear());

  it('reads per-group flag from localStorage', () => {
    localStorage.setItem(GROUP_COLLAPSE_PREFIX + 'r1', 'true');
    const groups = [group('r1', ['a']), group('r2', ['b'])];
    expect(readCollapsedGroups(groups)).toEqual({ r1: true, r2: false });
  });
});
