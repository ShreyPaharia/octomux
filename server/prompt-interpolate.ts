/**
 * Generic single-pass `{{key}}` interpolation for schedule prompts.
 *
 * Rules:
 * - Exactly one sweep — the output is never re-scanned. A var value that contains
 *   `{{otherKey}}` stays literal in the output (no fixpoint expansion).
 * - Scalars (string, number, boolean, null, undefined) are stringified via `String()`.
 * - Objects and arrays are stringified via `JSON.stringify`.
 * - Unknown placeholders (key not present in `vars`) are left intact.
 */
export function interpolatePrompt(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) return _match;
    const v = vars[key];
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}
