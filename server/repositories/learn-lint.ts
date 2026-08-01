const SECRET_PATTERNS: RegExp[] = [
  /\b(postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s]*:[^\s]*@/i, // creds in URI
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(sk|ghp|xox[baprs])-[A-Za-z0-9_-]{16,}\b/, // common token shapes
];
const INJECTION_PATTERNS: RegExp[] = [
  /\bcurl\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\b[^\n]*\|\s*(sh|bash)\b/i,
  /\beval\s*\(/i,
  /\b--dangerously[- ]/i,
];

export function lintLearning(lesson: string): { ok: true } | { ok: false; reason: string } {
  if (SECRET_PATTERNS.some((re) => re.test(lesson))) return { ok: false, reason: 'secret' };
  if (INJECTION_PATTERNS.some((re) => re.test(lesson))) return { ok: false, reason: 'injection' };
  return { ok: true };
}
