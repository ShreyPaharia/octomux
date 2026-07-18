import { Cron } from 'croner';

const cache = new Map<string, Cron>();

/** Returns true when `expr` matches `now` (UTC). Invalid expressions never match. */
export function isCronDue(expr: string, now: Date): boolean {
  try {
    let job = cache.get(expr);
    // paused:true is REQUIRED — teams.ts:231 uses it so croner doesn't arm a timer for a callback-less job
    if (!job) {
      job = new Cron(expr, { timezone: 'UTC', paused: true });
      cache.set(expr, job);
    }
    return job?.match(now) ?? false;
  } catch {
    return false;
  }
}
