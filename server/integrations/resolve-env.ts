/**
 * Resolve `${env:VAR_NAME}` placeholders in integration config values.
 *
 * Only string leaf values are examined; numbers, booleans, nulls, and arrays
 * are passed through unchanged.  The pattern may appear anywhere within a
 * string, e.g. `"Bearer ${env:MY_TOKEN}"`.
 *
 * If the referenced environment variable is not set (or is empty) the
 * placeholder is replaced with an empty string so that secret fields that
 * were not configured in the environment degrade gracefully instead of
 * sending a literal placeholder to the downstream API.
 */
export function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      return process.env[name] ?? '';
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}
