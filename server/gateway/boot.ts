import { childLogger } from '../logger.js';
import { createTelegramAdapter } from './telegram.js';
import { createGateway } from './gateway.js';

const logger = childLogger('gateway-boot');

/**
 * Start the Telegram gateway iff a bot token is configured — the feature is
 * opt-in. No token → no gateway (returns silently). Any startup error is logged,
 * never fatal to the server: a broken bot must not take down the dashboard.
 *
 * Wiring the actual bot to Telegram (long-poll) needs a live token, so this is
 * exercised manually (see server/gateway/README.md), not in CI.
 */
export async function startGatewayIfConfigured(): Promise<void> {
  const token = process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
  if (!token) {
    logger.debug({}, 'gateway: no OCTOMUX_GATEWAY_TELEGRAM_TOKEN — Telegram gateway disabled');
    return;
  }
  try {
    const adapter = createTelegramAdapter(token);
    const gateway = createGateway(adapter);
    await gateway.start();
    logger.info({}, 'gateway: Telegram gateway started');
  } catch (err) {
    logger.error({ err }, 'gateway: failed to start Telegram gateway');
  }
}
