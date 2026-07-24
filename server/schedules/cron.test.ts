import { describe, it, expect } from 'vitest';
import { isCronDue } from './cron.js';

describe('isCronDue', () => {
  // ── Original UTC cases ──────────────────────────────────────────────────────

  it.each([
    ['* * * * *', new Date('2026-07-18T07:00:00Z'), undefined, true],
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), undefined, true],
    ['0 7 * * *', new Date('2026-07-18T07:01:00Z'), undefined, false],
    ['0 7 * * 1-5', new Date('2026-07-20T07:00:00Z'), undefined, true], // Mon
    ['0 7 * * 1-5', new Date('2026-07-18T07:00:00Z'), undefined, false], // Sat
    ['not a cron', new Date('2026-07-18T07:00:00Z'), undefined, false],
    // Regression: non-zero seconds within the due minute must still match
    ['* * * * *', new Date('2026-07-18T07:00:37Z'), undefined, true],
    ['0 7 * * *', new Date('2026-07-18T07:00:45.912Z'), undefined, true],
    ['0 7 * * *', new Date('2026-07-18T07:01:30Z'), undefined, false],
  ])('%s @ %s (tz=%s) → %s', (e, n, tz, d) => expect(isCronDue(e, n, tz)).toBe(d));

  // ── Explicit UTC still works ────────────────────────────────────────────────

  it.each([
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), 'UTC', true],
    ['0 7 * * *', new Date('2026-07-18T07:01:00Z'), 'UTC', false],
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), null, true],
  ])('%s @ %s tz=%s → %s', (e, n, tz, d) => expect(isCronDue(e, n, tz)).toBe(d));

  // ── Offset timezone: America/New_York (UTC-4 in summer / EDT) ──────────────
  // "0 7 * * *" in America/New_York fires at 11:00 UTC in summer (EDT = UTC-4)

  it.each([
    // Due: 07:00 EDT = 11:00 UTC
    ['0 7 * * *', new Date('2026-07-18T11:00:00Z'), 'America/New_York', true],
    // Not due: 07:00 UTC (= 03:00 EDT, not 07:00 EDT)
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), 'America/New_York', false],
    // Non-zero seconds within due minute still match
    ['0 7 * * *', new Date('2026-07-18T11:00:45Z'), 'America/New_York', true],
  ])('%s @ %s in America/New_York → %s', (e, n, tz, d) => expect(isCronDue(e, n, tz)).toBe(d));

  // ── DST spring-forward: America/New_York 2026-03-08 (clocks forward at 02:00) ──
  // At 02:00 EST clocks jump to 03:00 EDT.
  // EDT = UTC-4, so 3am EDT = 07:00Z.
  // "0 3 * * *" in America/New_York fires at 07:00Z on spring-forward day.

  it('DST spring-forward: 0 3 * * * in America/New_York fires at 07:00Z (3am EDT)', () => {
    const springForwardDay = new Date('2026-03-08T07:00:00Z'); // 3am EDT = 07:00Z
    expect(isCronDue('0 3 * * *', springForwardDay, 'America/New_York')).toBe(true);
  });

  it('DST spring-forward: does not match 08:00Z (different hour)', () => {
    const wrongHour = new Date('2026-03-08T08:00:00Z'); // 4am EDT
    expect(isCronDue('0 3 * * *', wrongHour, 'America/New_York')).toBe(false);
  });

  // ── DST fall-back: America/New_York 2026-11-01 (clocks back at 02:00) ──────
  // At 02:00 EDT clocks fall back to 01:00 EST; 01:00 local appears twice.
  // "0 1 * * *" in America/New_York: first occurrence is at 05:00Z (1am EDT),
  // second occurrence at 06:00Z (1am EST). The same-minute guard in the poller
  // handles double-fire; isCronDue itself may match both.
  // We verify it matches at the first occurrence UTC instant.

  it('DST fall-back: 0 1 * * * in America/New_York matches first occurrence (05:00Z)', () => {
    const firstOccurrence = new Date('2026-11-01T05:00:00Z'); // 1am EDT
    expect(isCronDue('0 1 * * *', firstOccurrence, 'America/New_York')).toBe(true);
  });

  // ── Invalid timezone → false (never crash) ──────────────────────────────────

  it.each([
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), 'Not/AZone'],
    ['0 7 * * *', new Date('2026-07-18T07:00:00Z'), 'Mars/Olympus'],
  ])('%s in invalid tz %s → false', (e, n, tz) => {
    expect(isCronDue(e, n, tz)).toBe(false);
  });

  // ── Compound cache key: same expr, different timezones cached independently ──
  // "0 12 * * *" at noon UTC fires at:
  //   UTC       → 12:00Z
  //   Asia/Tokyo (UTC+9) → 03:00Z

  it('same expr in UTC and Asia/Tokyo are cached independently', () => {
    const utcNoon = new Date('2026-07-18T12:00:00Z');
    const tokyoNoon = new Date('2026-07-18T03:00:00Z'); // 12:00 JST = 03:00 UTC

    expect(isCronDue('0 12 * * *', utcNoon, 'UTC')).toBe(true);
    expect(isCronDue('0 12 * * *', tokyoNoon, 'Asia/Tokyo')).toBe(true);

    // And they don't cross-contaminate:
    expect(isCronDue('0 12 * * *', tokyoNoon, 'UTC')).toBe(false);
    expect(isCronDue('0 12 * * *', utcNoon, 'Asia/Tokyo')).toBe(false);
  });
});
