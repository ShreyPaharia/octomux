import { describe, it, expect } from 'vitest';
import { displayReviewTitle, parseActivityDate, riskBadgeClass } from '../review-display';

describe('review-display', () => {
  it('strips Review: prefix', () => {
    expect(displayReviewTitle('Review: feat(foo): bar')).toBe('feat(foo): bar');
  });

  it('parses SQLite datetime', () => {
    const d = parseActivityDate('2026-06-03 08:02:09');
    expect(d.getUTCFullYear()).toBe(2026);
  });

  it('maps risk to badge classes', () => {
    expect(riskBadgeClass('high')).toContain('destructive');
    expect(riskBadgeClass('medium')).toContain('amber');
  });
});
