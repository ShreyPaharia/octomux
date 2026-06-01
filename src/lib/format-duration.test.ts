import { describe, it, expect } from 'vitest';
import { formatDuration } from './format-duration';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [1_000, '1s'],
    [59_000, '59s'],
    [60_000, '1m 0s'],
    [74_000, '1m 14s'],
    [134_000, '2m 14s'],
    [480_000, '8m 0s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 0m'],
    [3_660_000, '1h 1m'],
    [7_530_000, '2h 5m'],
  ])('formats %ims as "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps negative input to 0s', () => {
    expect(formatDuration(-5_000)).toBe('0s');
  });
});
