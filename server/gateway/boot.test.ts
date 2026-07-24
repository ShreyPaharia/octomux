import { describe, it, expect, afterEach } from 'vitest';
import { startGatewayIfConfigured } from './boot.js';

afterEach(() => {
  delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
  delete process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
  delete process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
});

describe('startGatewayIfConfigured', () => {
  it('is a silent no-op when no token is configured', async () => {
    delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });

  it('does not start Slack when only the bot token is set', async () => {
    process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN = 'xoxb-fake';
    delete process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });

  it('does not start Slack when only the app token is set', async () => {
    delete process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
    process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN = 'xapp-fake';
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });
});
