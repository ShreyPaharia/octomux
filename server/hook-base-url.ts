/**
 * Local base URL the server listens on for hook callbacks. Used by
 * harness `installHooks` implementations. Honors `OCTOMUX_PORT` then
 * `PORT`, defaulting to 7777.
 */
export function hookBaseUrl(): string {
  const port = process.env.OCTOMUX_PORT || process.env.PORT || 7777;
  return `http://127.0.0.1:${port}`;
}
