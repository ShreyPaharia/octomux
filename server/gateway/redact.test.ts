import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it.each([
    ['db is postgres://svc:S3cr3t@db.prod:5432/x', 'S3cr3t'],
    ['token xoxb-123-abc456', 'xoxb-123-abc456'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'PRIVATE KEY'],
    ['use ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
  ])('redacts %s', (input) => {
    expect(redactSecrets(input)).toContain('‹redacted›');
  });
  it('leaves clean text untouched', () => {
    expect(redactSecrets('the retry lives in retry.ts')).toBe('the retry lives in retry.ts');
  });
});
