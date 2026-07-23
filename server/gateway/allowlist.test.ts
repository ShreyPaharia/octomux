import { describe, it, expect, afterEach } from 'vitest';
import { isAllowed } from './allowlist.js';

afterEach(() => {
  delete process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW;
  delete process.env.OCTOMUX_GATEWAY_SLACK_ALLOW;
});

describe('isAllowed', () => {
  it('denies by default when no allowlist is configured', () => {
    expect(isAllowed('telegram', '123')).toBe(false);
  });

  it('allows an id in the env allowlist and denies others', () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = '123, 456';
    expect(isAllowed('telegram', '123')).toBe(true);
    expect(isAllowed('telegram', '456')).toBe(true);
    expect(isAllowed('telegram', '999')).toBe(false);
  });

  it('compares ids as strings (numeric sender id matches string config)', () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = '123';
    expect(isAllowed('telegram', String(123))).toBe(true);
  });

  it('scopes the allowlist per channel', () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = '123';
    expect(isAllowed('telegram', '123')).toBe(true);
    expect(isAllowed('slack', '123')).toBe(false);
  });
});
