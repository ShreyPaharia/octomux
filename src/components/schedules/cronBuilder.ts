/**
 * Bidirectional bridge between a 5-field cron expression and the
 * frequency + time-of-day controls the schedule UI shows.
 *
 * Only the shapes the builder can produce round-trip; anything else parses as
 * `custom` and is edited as raw cron.
 */

export type CronFrequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export interface CronSchedule {
  frequency: CronFrequency;
  /** 'HH:MM'. For 'hourly' only the minutes are used. */
  time: string;
  /** '0'–'6', Sunday = 0. Only used by 'weekly'. */
  dayOfWeek: string;
}

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const FREQUENCY_LABELS: { id: CronFrequency; label: string }[] = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'custom', label: 'Custom' },
];

const DEFAULT_TIME = '09:00';
const DEFAULT_DOW = '1';

/** The cron the form starts on: every weekday at 09:00. */
export const DEFAULT_CRON = '0 9 * * 1-5';

const pad = (n: number) => String(n).padStart(2, '0');

function numeric(field: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n <= max ? n : null;
}

function custom(): CronSchedule {
  return { frequency: 'custom', time: DEFAULT_TIME, dayOfWeek: DEFAULT_DOW };
}

export function parseCron(cron: string): CronSchedule {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom();
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (dom !== '*' || mon !== '*') return custom();

  const m = numeric(min, 59);
  if (m === null) return custom();

  if (hour === '*') {
    return dow === '*'
      ? { frequency: 'hourly', time: `00:${pad(m)}`, dayOfWeek: DEFAULT_DOW }
      : custom();
  }

  const h = numeric(hour, 23);
  if (h === null) return custom();
  const time = `${pad(h)}:${pad(m)}`;

  if (dow === '*') return { frequency: 'daily', time, dayOfWeek: DEFAULT_DOW };
  if (dow === '1-5') return { frequency: 'weekdays', time, dayOfWeek: DEFAULT_DOW };
  if (/^[0-6]$/.test(dow)) return { frequency: 'weekly', time, dayOfWeek: dow };
  return custom();
}

export function buildCron(schedule: CronSchedule): string {
  const time = /^\d{1,2}:\d{2}$/.test(schedule.time) ? schedule.time : DEFAULT_TIME;
  const [h, m] = time.split(':').map(Number) as [number, number];
  switch (schedule.frequency) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${schedule.dayOfWeek}`;
    default:
      return '';
  }
}

/** Human summary shown under the frequency chips, e.g. "Runs daily at 09:00 UTC". */
export function describeCron(cron: string, timezone?: string | null): string {
  const trimmed = cron.trim();
  if (!trimmed) return 'No schedule set';
  const tz = timezone?.trim() || 'UTC';
  const s = parseCron(trimmed);
  switch (s.frequency) {
    case 'hourly':
      return `Runs every hour at :${s.time.slice(3)} (${tz})`;
    case 'daily':
      return `Runs daily at ${s.time} ${tz}`;
    case 'weekdays':
      return `Runs every weekday at ${s.time} ${tz}`;
    case 'weekly':
      return `Runs every ${DAY_NAMES[Number(s.dayOfWeek)]} at ${s.time} ${tz}`;
    default:
      return `Runs on cron ${trimmed} (${tz})`;
  }
}
