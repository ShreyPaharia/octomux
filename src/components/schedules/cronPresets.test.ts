import { describe, it, expect } from 'vitest';
import { cronPresetFromExpression, cronSummary } from './cronPresets';

describe('cronPresets', () => {
  it('maps known expressions to presets', () => {
    expect(cronPresetFromExpression('0 9 * * 1-5')).toBe('weekday');
    expect(cronPresetFromExpression('0 9 * * *')).toBe('daily');
    expect(cronPresetFromExpression('0 9 * * 1')).toBe('weekly');
    expect(cronPresetFromExpression('0 * * * *')).toBe('hourly');
  });

  it('treats unknown expressions as custom', () => {
    expect(cronPresetFromExpression('0 8 * * *')).toBe('custom');
  });

  it('returns human-readable summaries', () => {
    expect(cronSummary('0 9 * * 1-5')).toBe('Every weekday at 09:00');
    expect(cronSummary('0 12 * * *')).toBe('Custom: 0 12 * * *');
  });
});
