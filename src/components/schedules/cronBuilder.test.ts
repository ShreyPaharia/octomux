import { describe, it, expect } from 'vitest';
import { parseCron, buildCron, describeCron } from './cronBuilder';

describe('parseCron', () => {
  it.each([
    ['0 9 * * 1-5', 'weekdays', '09:00', '1'],
    ['30 14 * * *', 'daily', '14:30', '1'],
    ['0 9 * * 1', 'weekly', '09:00', '1'],
    ['15 * * * *', 'hourly', '00:15', '1'],
    ['0 9 1 * *', 'custom', '09:00', '1'],
    ['*/5 * * * *', 'custom', '09:00', '1'],
    ['0 9 * *', 'custom', '09:00', '1'],
    ['0 99 * * *', 'custom', '09:00', '1'],
  ])('%s → %s', (cron, frequency, time, dayOfWeek) => {
    expect(parseCron(cron)).toEqual({ frequency, time, dayOfWeek });
  });
});

describe('buildCron', () => {
  it.each([
    [{ frequency: 'hourly', time: '00:15', dayOfWeek: '1' }, '15 * * * *'],
    [{ frequency: 'daily', time: '14:30', dayOfWeek: '1' }, '30 14 * * *'],
    [{ frequency: 'weekdays', time: '09:00', dayOfWeek: '1' }, '0 9 * * 1-5'],
    [{ frequency: 'weekly', time: '07:05', dayOfWeek: '6' }, '5 7 * * 6'],
    [{ frequency: 'custom', time: '09:00', dayOfWeek: '1' }, ''],
  ] as const)('%o → %s', (schedule, expected) => {
    expect(buildCron(schedule)).toBe(expected);
  });

  it('round-trips every builder-produced shape', () => {
    for (const cron of ['15 * * * *', '30 14 * * *', '0 9 * * 1-5', '5 7 * * 6']) {
      expect(buildCron(parseCron(cron))).toBe(cron);
    }
  });

  it('falls back to 09:00 on a malformed time', () => {
    expect(buildCron({ frequency: 'daily', time: 'nope', dayOfWeek: '1' })).toBe('0 9 * * *');
  });
});

describe('describeCron', () => {
  it('names the frequency and timezone', () => {
    expect(describeCron('0 9 * * 1-5', 'Asia/Kolkata')).toBe(
      'Runs every weekday at 09:00 Asia/Kolkata',
    );
    expect(describeCron('0 9 * * 0')).toBe('Runs every Sunday at 09:00 UTC');
    expect(describeCron('*/5 * * * *')).toBe('Runs on cron */5 * * * * (UTC)');
    expect(describeCron('  ')).toBe('No schedule set');
  });
});
