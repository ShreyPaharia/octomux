import { describe, it, expect } from 'vitest';
import { telegramGatewayProvider } from './index.js';

describe('telegramGatewayProvider', () => {
  it('has the expected shape', () => {
    expect(telegramGatewayProvider.kind).toBe('telegram-gateway');
    expect(telegramGatewayProvider.displayName).toBe('Telegram Gateway');
    expect(telegramGatewayProvider.events).toEqual([]);
  });

  it('marks token as secret in the schema', () => {
    const props = telegramGatewayProvider.configSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.token.secret).toBe(true);
    expect(props.allow.secret).toBeUndefined();
  });

  it.each([
    ['an empty object', {}, true],
    ['token set', { token: '123:abc' }, true],
    ['token and allow set', { token: '123:abc', allow: '1,2' }, true],
    ['token not a string', { token: 42 }, false],
    ['allow not a string', { allow: [1, 2] }, false],
    ['config not an object', null, false],
  ])('validate(%s) -> ok=%s', (_name, config, ok) => {
    expect(telegramGatewayProvider.validate(config).ok).toBe(ok);
  });

  it('handler is a no-op (never invoked — events is empty)', async () => {
    await expect(
      telegramGatewayProvider.handler({ event: 'note_added' } as any, {}),
    ).resolves.toBeUndefined();
  });
});
