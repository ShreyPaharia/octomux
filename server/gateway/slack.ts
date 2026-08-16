import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { childLogger } from '../logger.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';

const logger = childLogger('gateway-slack');

/** The inner Slack event delivered for the 'message' subscription. */
interface SlackMessageEvent {
  type: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * `socket.on('message', ...)` is untyped upstream (SocketModeClient extends
 * a plain EventEmitter) — this shapes the payload we actually destructure.
 */
interface SlackMessageEventPayload {
  ack: (response?: unknown) => Promise<void>;
  envelope_id: string;
  body?: { event_id?: string };
  event: SlackMessageEvent;
}

export interface SlackAdapterOptions {
  /** Inject a pre-built WebClient — used by tests so `send()` never hits the network. */
  client?: WebClient;
  /** Inject a pre-built SocketModeClient — used by tests to emit fake events without connecting. */
  socket?: SocketModeClient;
}

/**
 * Builds the underlying `WebClient`/`SocketModeClient` alongside the
 * `ChannelAdapter`. Exported (rather than just `createSlackAdapter`) so
 * tests can reach the socket directly — to emit fake `message` events via
 * `socket.emit()` and to inject a stub `WebClient` that records outbound
 * calls instead of hitting the network.
 */
export function buildSlack(botToken: string, appToken: string, opts: SlackAdapterOptions = {}) {
  const client = opts.client ?? new WebClient(botToken);
  const socket = opts.socket ?? new SocketModeClient({ appToken });

  const adapter: ChannelAdapter = {
    id: 'slack',

    async start(onMessage: (m: InboundMessage) => Promise<void>) {
      socket.on('message', async ({ event, body, ack }: SlackMessageEventPayload) => {
        // Always ack first — Slack redelivers events that aren't acked, even
        // ones we intend to ignore.
        await ack();

        // Ignore the bot's own messages/edits/joins to avoid an echo loop.
        if (event.bot_id || event.subtype || !event.user || !event.text) {
          return;
        }

        const message: InboundMessage = {
          channel: 'slack',
          threadKey: String(event.channel),
          senderId: String(event.user),
          externalId: String(body?.event_id ?? event.ts),
          text: event.text,
        };

        try {
          await onMessage(message);
        } catch (err) {
          logger.error({ err, thread_key: message.threadKey }, 'slack onMessage handler threw');
        }
      });

      await socket.start();
    },

    async send(threadKey: string, text: string) {
      await client.chat.postMessage({ channel: threadKey, text });
    },

    async sendTyping(_threadKey: string) {
      // ponytail: no-op — Slack has no bot typing indicator over the Web API; revisit if the assistant-threads typing API becomes generally available.
    },
  };

  return { adapter, socket, client };
}

export function createSlackAdapter(
  botToken: string,
  appToken: string,
  opts?: SlackAdapterOptions,
): ChannelAdapter {
  return buildSlack(botToken, appToken, opts).adapter;
}
