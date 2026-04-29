import { describe, it, expect } from 'vitest';
import { findHunkLine } from './diff-hunks';

const changes = [
  { modifiedStartLineNumber: 10 },
  { modifiedStartLineNumber: 25 },
  { modifiedStartLineNumber: 60 },
];

describe('findHunkLine', () => {
  it('returns null when there are no changes', () => {
    expect(findHunkLine([], 1, 1)).toBeNull();
    expect(findHunkLine(null, 1, 1)).toBeNull();
    expect(findHunkLine(undefined, 1, -1)).toBeNull();
  });

  it.each([
    [1, 10],
    [9, 10],
    [10, 25],
    [24, 25],
    [25, 60],
    [59, 60],
  ])('next: from line %i jumps to %i', (from, expected) => {
    expect(findHunkLine(changes, from, 1)).toBe(expected);
  });

  it('next: wraps from after last change to first', () => {
    expect(findHunkLine(changes, 100, 1)).toBe(10);
  });

  it.each([
    [11, 10],
    [25, 10],
    [26, 25],
    [60, 25],
    [61, 60],
  ])('prev: from line %i jumps to %i', (from, expected) => {
    expect(findHunkLine(changes, from, -1)).toBe(expected);
  });

  it('prev: wraps from before first change to last', () => {
    expect(findHunkLine(changes, 1, -1)).toBe(60);
  });

  it('handles unsorted change input', () => {
    const unsorted = [
      { modifiedStartLineNumber: 60 },
      { modifiedStartLineNumber: 10 },
      { modifiedStartLineNumber: 25 },
    ];
    expect(findHunkLine(unsorted, 5, 1)).toBe(10);
    expect(findHunkLine(unsorted, 30, -1)).toBe(25);
  });
});
