import { Cron } from 'croner';
import { badRequest, ServiceError } from '../services/errors.js';

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

/**
 * Validate a cron expression against a timezone.
 * Throws a 400 badRequest distinguishing expression vs. timezone errors.
 *
 * croner does not throw at construction time for invalid timezones — it only
 * throws on .match(). We probe with a .match() call to trigger validation.
 * To distinguish expression errors from timezone errors, we first try with UTC:
 * if UTC also throws, the expression is bad; otherwise the timezone is bad.
 */
export function validateCronWithTimezone(expr: string, timezone?: string | null): void {
  const tz = timezone ?? 'UTC';
  try {
    const job = new Cron(expr, { timezone: tz, paused: true });
    // Probe to trigger timezone validation (croner validates timezone lazily on match)
    job.match(new Date());
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    // Distinguish: try with UTC — if it also throws, the expression is bad;
    // if UTC works, the timezone is the problem.
    if (tz !== 'UTC') {
      try {
        const utcJob = new Cron(expr, { timezone: 'UTC', paused: true });
        utcJob.match(new Date());
        // Expression valid with UTC → timezone is the problem
        throw badRequest(`invalid timezone: ${tz}`);
      } catch (innerErr) {
        if (innerErr instanceof ServiceError) throw innerErr;
        // Also fails with UTC → expression is the problem
        throw badRequest(`invalid cron expression: ${expr}`);
      }
    }
    throw badRequest(`invalid cron expression: ${expr}`);
  }
}

/** Boolean, non-throwing check — used by preset load-time validation (§3.2),
 * which must never crash boot on a bad `defaultCron` in a hand-edited file. */
export function isValidCronExpression(expr: string): boolean {
  try {
    validateCronWithTimezone(expr, 'UTC');
    return true;
  } catch {
    return false;
  }
}
