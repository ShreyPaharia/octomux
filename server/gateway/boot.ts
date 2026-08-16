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
 * Read a string field from the first enabled `kind` integration row, or
 * undefined if there's no such integration, it's disabled, or the field
 * isn't a non-empty string. Errors (DB/store unavailable) resolve to
 * undefined rather than throwing — same "silent no-op" contract as a
 * missing env var.
 */
async function integrationField(kind: string, field: string): Promise<string | undefined> {
  try {
    const { listIntegrations } = await import('../integrations/store.js');
    const row = listIntegrations().find((i) => i.kind === kind && i.enabled);
    const value = (row?.config as Record<string, unknown> | undefined)?.[field];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a gateway credential: the env var overrides the stored
 * `kind` integration's `field`, which overrides "unset" (gateway disabled).
 */
async function resolveCredential(
  envVar: string,
  kind: string,
  field: string,
): Promise<string | undefined> {
  const envVal = process.env[envVar];
  if (envVal) return envVal;
  return integrationField(kind, field);
}

/**
 * Start the Telegram and/or Slack gateways, each opt-in independently.
 *
 * Telegram starts iff a bot token is configured (env OCTOMUX_GATEWAY_TELEGRAM_TOKEN,
 * else the `telegram-gateway` integration's `token`). Slack starts iff both a bot
 * token and an app-level token (for Socket Mode) are configured — same env-then-
 * `slack-gateway`-integration resolution per token; if only one resolves, a
 * warning is logged naming the missing one and Slack stays off. Missing config
 * for one channel never affects the other. Any startup error is logged, never
 * fatal to the server: a broken bot must not take down the dashboard.
 *
 * Wiring the actual bots (Telegram long-poll, Slack Socket Mode) needs live
 * tokens, so this is exercised manually (see server/gateway/README.md), not
 * in CI.
 */
export async function startGatewayIfConfigured(): Promise<void> {
  const telegramToken = await resolveCredential(
    'OCTOMUX_GATEWAY_TELEGRAM_TOKEN',
    'telegram-gateway',
    'token',
  );
  if (!telegramToken) {
    logger.debug(
      {},
      'gateway: no Telegram token configured (env OCTOMUX_GATEWAY_TELEGRAM_TOKEN or the telegram-gateway integration) — Telegram gateway disabled',
    );
  } else {
    await startChannel('Telegram', () => createTelegramAdapter(telegramToken));
  }

  const slackBotToken = await resolveCredential(
    'OCTOMUX_GATEWAY_SLACK_BOT_TOKEN',
    'slack-gateway',
    'bot_token',
  );
  const slackAppToken = await resolveCredential(
    'OCTOMUX_GATEWAY_SLACK_APP_TOKEN',
    'slack-gateway',
    'app_token',
  );
  if (slackBotToken && slackAppToken) {
    await startChannel('Slack', () => createSlackAdapter(slackBotToken, slackAppToken));
  } else if (slackBotToken && !slackAppToken) {
    logger.warn(
      {},
      'gateway: Slack app token missing (env OCTOMUX_GATEWAY_SLACK_APP_TOKEN or the slack-gateway integration) — Slack gateway disabled',
    );
  } else if (slackAppToken && !slackBotToken) {
    logger.warn(
      {},
      'gateway: Slack bot token missing (env OCTOMUX_GATEWAY_SLACK_BOT_TOKEN or the slack-gateway integration) — Slack gateway disabled',
    );
  } else {
    logger.debug({}, 'gateway: no Slack tokens configured — Slack gateway disabled');
  }
}
