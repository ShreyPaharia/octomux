import { describe, it, expect } from '../../bun-test.js';
import { slackGatewayProvider } from './index.js';

describe('slackGatewayProvider', () => {
  it('has the expected shape', () => {
    expect(slackGatewayProvider.kind).toBe('slack-gateway');
    expect(slackGatewayProvider.displayName).toBe('Slack Gateway');
    expect(slackGatewayProvider.events).toEqual([]);
  });

  it('marks bot_token and app_token as secret in the schema', () => {
    const props = slackGatewayProvider.configSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.bot_token.secret).toBe(true);
    expect(props.app_token.secret).toBe(true);
    expect(props.allow.secret).toBeUndefined();
  });

  it.each([
    ['an empty object', {}, true],
    ['only bot_token set', { bot_token: 'xoxb-x' }, true],
    ['all fields set', { bot_token: 'xoxb-x', app_token: 'xapp-x', allow: 'U1,U2' }, true],
    ['bot_token not a string', { bot_token: 42 }, false],
    ['allow not a string', { allow: ['U1'] }, false],
    ['config not an object', 'nope', false],
  ])('validate(%s) -> ok=%s', (_name, config, ok) => {
    expect(slackGatewayProvider.validate(config).ok).toBe(ok);
  });

  it('handler is a no-op (never invoked — events is empty)', async () => {
    await expect(
      slackGatewayProvider.handler({ event: 'note_added' } as any, {}),
    ).resolves.toBeUndefined();
  });
});
