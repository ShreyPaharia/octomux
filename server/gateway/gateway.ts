/**
 * server/gateway/gateway.ts
 *
 * The gateway glue (Phase 2 / T8). Ties a ChannelAdapter (Telegram) to the
 * existing octomux conductor:
 *
 *   inbound → allowlist → dedup → map/create conversation → sendTurn
 *           → tail assistant lines + turn-done → redact → OutboundQueue → send
 *
 * The conductor IS the assistant brain — this module never calls a model. It
 * only routes chat turns into the conductor's pane and its replies back out.
 *
 * Security (v1): the owner allowlist is the trust boundary (default-deny); outward
 * write capability is withheld by credential, not gated here (see spec).
 */

import { childLogger } from '../logger.js';
import { isAllowed, type Channel } from './allowlist.js';
import { redactSecrets } from './redact.js';
import { OutboundQueue } from './outbound.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { getThreadConv, setThreadConv, seenInbound, markInbound } from '../repositories/gateway.js';
import { createConversation, getConversation } from '../orchestrator/store.js';
import { startConversation, sendTurn, interruptTurn } from '../orchestrator/runner.js';
import { registerTranscriptConsumer } from '../orchestrator/stream.js';
import { isTurnDone, type ChatEvent } from '../orchestrator/transcript.js';

const logger = childLogger('gateway');

/** cwd the gateway conductor sessions launch from (the repo the assistant works in). */
function gatewayCwd(): string {
  return process.env.OCTOMUX_GATEWAY_CWD || process.cwd();
}

interface ThreadState {
  convId: string;
  channel: Channel;
  threadKey: string;
  /** Assistant text lines accumulated for the in-flight turn. */
  buffer: string[];
  /** True between sending a turn and its stop_hook_summary boundary. */
  inFlight: boolean;
  unregister: () => void;
}

/**
 * Injection seam for tests — only the calls that touch tmux / the live
 * transcript tail are swapped for fakes. DB ops (conversation + thread rows) run
 * against the real (test) DB, so the routing/dedup/mapping logic is exercised for
 * real. Production uses `realConductor` (the module functions above).
 */
export interface GatewayConductor {
  startConversation(convId: string, cwd: string): Promise<void>;
  sendTurn(convId: string, text: string): Promise<void>;
  interruptTurn(convId: string): Promise<void>;
  registerConsumer(
    convId: string,
    transcriptPath: string,
    consumer: (e: ChatEvent) => void,
  ): () => void;
}

const realConductor: GatewayConductor = {
  startConversation: (convId, cwd) => startConversation(convId, cwd),
  sendTurn,
  interruptTurn,
  registerConsumer: registerTranscriptConsumer,
};

export interface Gateway {
  start(): Promise<void>;
  /** Exposed for tests — the adapter's onMessage callback. */
  handleInbound(msg: InboundMessage): Promise<void>;
}

export function createGateway(
  adapter: ChannelAdapter,
  conductor: GatewayConductor = realConductor,
): Gateway {
  const outbound = new OutboundQueue((threadKey, text) => adapter.send(threadKey, text));
  const threads = new Map<string, ThreadState>();

  const key = (channel: Channel, threadKey: string) => `${channel}:${threadKey}`;

  function makeConsumer(state: ThreadState): (e: ChatEvent) => void {
    return (event) => {
      if (event.type === 'assistant' && event.text.trim()) {
        state.buffer.push(event.text);
        return;
      }
      if (isTurnDone(event)) {
        const reply = redactSecrets(state.buffer.join('\n\n').trim());
        state.buffer = [];
        state.inFlight = false;
        if (reply) outbound.enqueue(state.threadKey, reply);
      }
    };
  }

  async function ensureThread(msg: InboundMessage): Promise<ThreadState> {
    const k = key(msg.channel, msg.threadKey);
    const existing = threads.get(k);
    if (existing) return existing;

    // Reconnect to a mapped conversation across restarts, or create a new one.
    let convId = getThreadConv(msg.channel, msg.threadKey);
    if (!convId || !getConversation(convId)) {
      convId = createConversation({ title: `${msg.channel}:${msg.threadKey}` });
      await conductor.startConversation(convId, gatewayCwd());
      setThreadConv(msg.channel, msg.threadKey, convId);
    }

    const transcriptPath = getConversation(convId)?.transcript_path;
    if (!transcriptPath) {
      throw new Error(`gateway: conversation ${convId} has no transcript path`);
    }

    const state: ThreadState = {
      convId,
      channel: msg.channel,
      threadKey: msg.threadKey,
      buffer: [],
      inFlight: false,
      unregister: () => {},
    };
    state.unregister = conductor.registerConsumer(convId, transcriptPath, makeConsumer(state));
    threads.set(k, state);
    return state;
  }

  async function handleInbound(msg: InboundMessage): Promise<void> {
    // 1. Owner allowlist — the trust boundary. Default-deny drops silently.
    if (!isAllowed(msg.channel, msg.senderId)) return;

    // 2. Dedup — channels redeliver on retry; process each external id once.
    if (seenInbound(msg.channel, msg.externalId)) return;
    markInbound(msg.channel, msg.externalId);

    try {
      const state = await ensureThread(msg);

      // 3. Turn policy: if a turn is already running, interrupt-and-merge — the
      //    new message is likely related, so stop the current turn and push the
      //    new one rather than queueing behind a possibly-stale answer.
      if (state.inFlight) {
        await conductor.interruptTurn(state.convId);
      }
      state.buffer = [];
      state.inFlight = true;

      void adapter.sendTyping(msg.threadKey).catch(() => undefined);
      await conductor.sendTurn(state.convId, msg.text);
    } catch (err) {
      logger.error(
        { channel: msg.channel, thread_key: msg.threadKey, err },
        'gateway: failed to handle inbound message',
      );
    }
  }

  return {
    async start() {
      logger.info({ adapter: adapter.id }, 'gateway: starting');
      await adapter.start(handleInbound);
    },
    handleInbound,
  };
}
