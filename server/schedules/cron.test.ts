import { describe, it, expect } from 'vitest';
import { isCronDue } from './cron.js';

describe('isCronDue', () => {
  it.each([
    ['* * * * *', new Date('2026-07-18T07:00:00Z'), true],
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), true],
    ['0 7 * * *', new Date('2026-07-18T07:01:00Z'), false],
    ['0 7 * * 1-5', new Date('2026-07-20T07:00:00Z'), true], // Mon
    ['0 7 * * 1-5', new Date('2026-07-18T07:00:00Z'), false], // Sat
    ['not a cron', new Date('2026-07-18T07:00:00Z'), false],
  ])('%s @ %s → %s', (e, n, d) => expect(isCronDue(e, n)).toBe(d));
});
