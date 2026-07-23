import { Bot } from 'grammy';
import type { Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { childLogger } from '../logger.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';

const logger = childLogger('gateway-telegram');

export interface TelegramAdapterOptions {
  /** Pre-seed bot identity to skip the `getMe` network call — used by tests. */
  botInfo?: UserFromGetMe;
  /** Intercept outgoing API calls — used by tests, never in production. */
  apiTransformer?: Transformer;
}

/**
 * Builds the underlying grammY `Bot` alongside the `ChannelAdapter`. Exported
 * (rather than just `createTelegramAdapter`) so tests can reach the bot
 * directly — to feed fake updates via `bot.handleUpdate()` and to install an
 * `apiTransformer` that records outbound calls instead of hitting the network.
 */
export function buildTelegram(token: string, opts: TelegramAdapterOptions = {}) {
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  if (opts.apiTransformer) {
    bot.api.config.use(opts.apiTransformer);
  }

  const adapter: ChannelAdapter = {
    id: 'telegram',

    async start(onMessage: (m: InboundMessage) => Promise<void>) {
      bot.on('message:text', async (ctx) => {
        await onMessage({
          channel: 'telegram',
          threadKey: String(ctx.chat.id),
          senderId: String(ctx.from?.id ?? ''),
          externalId: String(ctx.update.update_id),
          text: ctx.message.text,
        });
      });

      // bot.start() long-polls forever and never resolves — fire it without
      // awaiting so start() itself resolves once handlers are registered.
      bot.start().catch((err) => {
        logger.error({ err }, 'telegram polling error');
      });
    },

    async send(threadKey: string, text: string) {
      await bot.api.sendMessage(Number(threadKey), text, { parse_mode: 'HTML' });
    },

    async sendTyping(threadKey: string) {
      await bot.api.sendChatAction(Number(threadKey), 'typing');
    },
  };

  return { adapter, bot };
}

export function createTelegramAdapter(
  token: string,
  opts?: TelegramAdapterOptions,
): ChannelAdapter {
  return buildTelegram(token, opts).adapter;
}
