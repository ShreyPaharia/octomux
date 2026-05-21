import { describe, it, expect } from 'vitest';
import { buildSgrWheelSequence } from './terminal-wheel';

describe('buildSgrWheelSequence', () => {
  it('returns "" for a deltaY of 0', () => {
    expect(buildSgrWheelSequence(0)).toBe('');
  });

  it('emits SGR wheel-up (button 64) for negative deltaY (scroll up)', () => {
    expect(buildSgrWheelSequence(-100)).toBe('\x1b[<64;1;1M');
  });

  it('emits SGR wheel-down (button 65) for positive deltaY (scroll down)', () => {
    expect(buildSgrWheelSequence(120)).toBe('\x1b[<65;1;1M');
  });
});
