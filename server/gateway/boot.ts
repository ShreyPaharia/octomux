import { childLogger } from '../logger.js';
import { createTelegramAdapter } from './telegram.js';
import { createSlackAdapter } from './slack.js';
import { createGateway } from './gateway.js';
import type { ChannelAdapter } from './adapter.js';

const logger = childLogger('gateway-boot');

async function startChannel(label: string, buildAdapter: () => ChannelAdapter): Promise<void> {
  try {
    const gateway = createGateway(buildAdapter());
    await gateway.start();
    logger.info({}, `gateway: ${label} gateway started`);
  } catch (err) {
    logger.error({ err }, `gateway: failed to start ${label} gateway`);
  }
}

/**
 * Start the Telegram and/or Slack gateways, each opt-in independently.
 *
 * Telegram starts iff a bot token is configured. Slack starts iff both a bot
 * token and an app-level token (for Socket Mode) are configured; if only one
 * is present, a warning is logged naming the missing one and Slack stays off.
 * Missing config for one channel never affects the other. Any startup error
 * is logged, never fatal to the server: a broken bot must not take down the
 * dashboard.
 *
 * Wiring the actual bots (Telegram long-poll, Slack Socket Mode) needs live
 * tokens, so this is exercised manually (see server/gateway/README.md), not
 * in CI.
 */
export async function startGatewayIfConfigured(): Promise<void> {
  const telegramToken = process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
  if (!telegramToken) {
    logger.debug({}, 'gateway: no OCTOMUX_GATEWAY_TELEGRAM_TOKEN — Telegram gateway disabled');
  } else {
    await startChannel('Telegram', () => createTelegramAdapter(telegramToken));
  }

  const slackBotToken = process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
  const slackAppToken = process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
  if (slackBotToken && slackAppToken) {
    await startChannel('Slack', () => createSlackAdapter(slackBotToken, slackAppToken));
  } else if (slackBotToken && !slackAppToken) {
    logger.warn({}, 'gateway: OCTOMUX_GATEWAY_SLACK_APP_TOKEN missing — Slack gateway disabled');
  } else if (slackAppToken && !slackBotToken) {
    logger.warn({}, 'gateway: OCTOMUX_GATEWAY_SLACK_BOT_TOKEN missing — Slack gateway disabled');
  } else {
    logger.debug({}, 'gateway: no Slack tokens configured — Slack gateway disabled');
  }
}
