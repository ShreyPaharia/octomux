/**
 * Scrubs live secret values out of egress text (log lines, `runs.result_json`).
 *
 * ZERO imports, deliberately: `server/logger.ts` imports this module to redact
 * every log line at the write() choke point, and `server/secrets/store.ts`
 * (which imports `../db.js`, which imports `../logger.js`) would form a cycle
 * through logger.ts if this lived there instead.
 */

/** Values short enough to collide with ordinary log text are not redacted.
 *  ponytail: length floor, not entropy — a 6-char token that leaks is a bad token. */
export const REDACT_MIN_LENGTH = 8;
export const REDACTED = '••••';

const rememberedValues = new Set<string>();

/** Records a live secret value so it can be scrubbed from egress. Called by the
 *  store on write and on every decrypt. No-op for values under REDACT_MIN_LENGTH. */
export function rememberSecretValue(value: string): void {
  if (value.length < REDACT_MIN_LENGTH) return;
  rememberedValues.add(value);
}

/** Replaces every remembered secret value in `text` with REDACTED. */
export function redactSecretValues(text: string): string {
  let result = text;
  for (const value of rememberedValues) {
    if (result.includes(value)) {
      result = result.split(value).join(REDACTED);
    }
  }
  return result;
}

/** Test-only. */
export function resetRedaction(): void {
  rememberedValues.clear();
}
