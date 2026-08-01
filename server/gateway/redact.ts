const SECRET_PATTERNS: RegExp[] = [
  /\b(postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s]*:[^\s@]*@/gi, // creds in URI
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(sk|ghp|xox[baprs])[_-][A-Za-z0-9_-]{8,}\b/g, // common token shapes
  /\b[A-Z][A-Z0-9_]{2,}=[^\s]{8,}\b/g, // KEY=value env lines
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((s, re) => s.replace(re, '‹redacted›'), text);
}
