import { describe, it, expect, beforeEach } from '../bun-test.js';
import {
  rememberSecretValue,
  redactSecretValues,
  resetRedaction,
  REDACT_MIN_LENGTH,
  REDACTED,
} from './redact.js';

describe('redact', () => {
  beforeEach(() => {
    resetRedaction();
  });

  it('replaces a remembered value with REDACTED', () => {
    rememberSecretValue('super-secret-token');
    expect(redactSecretValues('auth failed for super-secret-token on retry')).toBe(
      `auth failed for ${REDACTED} on retry`,
    );
  });

  it('ignores values shorter than REDACT_MIN_LENGTH', () => {
    const short = 'a'.repeat(REDACT_MIN_LENGTH - 1);
    rememberSecretValue(short);
    expect(redactSecretValues(`token=${short}`)).toBe(`token=${short}`);
  });

  it('redacts a value at exactly REDACT_MIN_LENGTH', () => {
    const value = 'a'.repeat(REDACT_MIN_LENGTH);
    rememberSecretValue(value);
    expect(redactSecretValues(`token=${value}`)).toBe(`token=${REDACTED}`);
  });

  it('handles multiple occurrences of the same value', () => {
    rememberSecretValue('leaked-value-1');
    const text = 'first: leaked-value-1, second: leaked-value-1';
    expect(redactSecretValues(text)).toBe(`first: ${REDACTED}, second: ${REDACTED}`);
  });

  it('redacts multiple distinct remembered values in one string', () => {
    rememberSecretValue('secret-value-one');
    rememberSecretValue('secret-value-two');
    const text = 'a=secret-value-one b=secret-value-two';
    expect(redactSecretValues(text)).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it('leaves text with no remembered values unchanged', () => {
    expect(redactSecretValues('nothing secret here')).toBe('nothing secret here');
  });

  it('resetRedaction clears remembered values', () => {
    rememberSecretValue('another-long-secret');
    resetRedaction();
    expect(redactSecretValues('another-long-secret')).toBe('another-long-secret');
  });
});
