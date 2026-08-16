import { describe, it, expect, afterEach, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import { createIntegration, setEnabled } from '../integrations/store.js';
import { isAllowed } from './allowlist.js';

beforeEach(() => {
  // isAllowed() now also consults the <channel>-gateway integration's `allow`
  // field — isolate against an in-memory DB rather than the real dev/prod one.
  createTestDb();
});

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

describe('isAllowed — stored telegram-gateway/slack-gateway integration', () => {
  it.each([
    ['telegram', 'telegram-gateway'],
    ['slack', 'slack-gateway'],
  ] as const)(
    '%s: allows an id from the stored %s integration when env is absent',
    (channel, kind) => {
      createIntegration(kind, 'Gateway', { allow: '123, 456' });
      expect(isAllowed(channel, '123')).toBe(true);
      expect(isAllowed(channel, '456')).toBe(true);
      expect(isAllowed(channel, '999')).toBe(false);
    },
  );

  it('ignores a disabled integration row', () => {
    const integration = createIntegration('telegram-gateway', 'Gateway', { allow: '123' });
    setEnabled(integration.id, false);
    expect(isAllowed('telegram', '123')).toBe(false);
  });

  it('env overrides the stored integration entirely (not additive)', () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = '123';
    createIntegration('telegram-gateway', 'Gateway', { allow: '999' });
    expect(isAllowed('telegram', '123')).toBe(true);
    expect(isAllowed('telegram', '999')).toBe(false);
  });

  it('scopes the stored integration allowlist per channel', () => {
    createIntegration('slack-gateway', 'Gateway', { allow: '123' });
    expect(isAllowed('slack', '123')).toBe(true);
    expect(isAllowed('telegram', '123')).toBe(false);
  });
});
