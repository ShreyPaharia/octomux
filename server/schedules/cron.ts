import { Cron } from 'croner';

const cache = new Map<string, Cron>();

/**
 * Returns true when 5-field `expr` is due during the minute containing `now`,
 * evaluated in the given `timezone` (IANA zone; defaults to 'UTC').
 * Invalid expressions or unknown timezones never match.
 *
 * Cache key: `${timezone ?? 'UTC'}\n${expr}` — \n cannot appear in a valid
 * cron expression (croner rejects it), so this is collision-free.
 *
 * NOTE: croner's `.match()` is second-exact, but the poller passes wall-clock
 * `new Date()` (arbitrary seconds), so matching `now` directly would only ever
 * fire on the rare tick that lands on `:00`. We normalize to the start of the
 * minute so a schedule fires anywhere within its due minute.
 */
export function isCronDue(expr: string, now: Date, timezone?: string | null): boolean {
  try {
    const tz = timezone ?? 'UTC';
    const cacheKey = `${tz}\n${expr}`;
    let job = cache.get(cacheKey);
    // paused:true is REQUIRED — croner won't arm a timer for a callback-less job
    if (!job) {
      job = new Cron(expr, { timezone: tz, paused: true });
      cache.set(cacheKey, job);
    }
    const atMinute = new Date(now);
    atMinute.setUTCSeconds(0, 0);
    return job?.match(atMinute) ?? false;
  } catch {
    return false;
  }
}
