/** Single-quote a string for safe interpolation into a POSIX shell command. */
export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
