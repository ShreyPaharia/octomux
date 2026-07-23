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
import {
  createConversation,
  getConversation,
  getPrimaryAgentConversation,
} from '../orchestrator/store.js';
import { getAgentByChannel } from '../repositories/agents-config.js';
import { startConversation, sendTurn, interruptTurn } from '../orchestrator/runner.js';
import type { StartConversationOpts } from '../orchestrator/runner.js';
import {
  registerTranscriptConsumer,
  registerConversationMessageListener,
} from '../orchestrator/stream.js';
import type { OrchestratorWsEvent } from '../orchestrator/stream.js';
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
  /** Unregisters the conversation-message listener (worker reports; Task 6). */
  unregisterMessages: () => void;
}

/**
 * Injection seam for tests — only the calls that touch tmux / the live
 * transcript tail are swapped for fakes. DB ops (conversation + thread rows) run
 * against the real (test) DB, so the routing/dedup/mapping logic is exercised for
 * real. Production uses `realConductor` (the module functions above).
 */
export interface GatewayConductor {
  startConversation(convId: string, cwd: string, opts?: StartConversationOpts): Promise<void>;
  sendTurn(convId: string, text: string): Promise<void>;
  interruptTurn(convId: string): Promise<void>;
  registerConsumer(
    convId: string,
    transcriptPath: string,
    consumer: (e: ChatEvent) => void,
  ): () => void;
}

const realConductor: GatewayConductor = {
  startConversation: (convId, cwd, opts) => startConversation(convId, cwd, opts),
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

  /**
   * Format a supervisor-pushed `card` event as plain text with a tappable
   * artifact link, for channels (Telegram) that have no card UI.
   */
  function formatCardEvent(event: Extract<OrchestratorWsEvent, { type: 'card' }>): string {
    const args = event.args;
    const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
    const artifactUrl = typeof args.artifact_url === 'string' ? args.artifact_url : undefined;
    const label =
      event.command === 'approve-plan'
        ? 'plan ready for review'
        : event.command === 'view-spec'
          ? 'spec ready for review'
          : event.command;
    const prefix = taskId ? `[${taskId}] ` : '';
    return artifactUrl ? `${prefix}${label}: ${artifactUrl}` : `${prefix}${label}`;
  }

  /**
   * Worker reports reach the owning agent (Task 6): the supervisor relays a
   * worker's `task:phase_complete` (and other notes) via `pushToConversation`,
   * which only reached WS clients before. This listener is the gateway's other
   * ear on that same conversation, so a bound channel gets the report too —
   * with the artifact URL as a tappable link. It's a distinct source from the
   * live transcript tail (`makeConsumer` above), so nothing here is
   * double-delivered by the transcript path.
   */
  function makeMessageListener(state: ThreadState): (event: OrchestratorWsEvent) => void {
    return (event) => {
      if (event.type === 'message') {
        if (event.role !== 'assistant') return;
        const text = redactSecrets(event.text.trim());
        if (text) outbound.enqueue(state.threadKey, text);
        return;
      }
      if (event.type === 'card') {
        const text = redactSecrets(formatCardEvent(event));
        if (text) outbound.enqueue(state.threadKey, text);
      }
    };
  }

  async function ensureThread(msg: InboundMessage): Promise<ThreadState> {
    const k = key(msg.channel, msg.threadKey);
    const existing = threads.get(k);
    if (existing) return existing;

    // Agents feature: if this (channel, threadKey) is bound to an agent, route
    // to that agent's ONE persistent session — reused across every message and
    // every thread bound to it, and across restarts (found again next time via
    // getPrimaryAgentConversation, no thread-map row needed). Falls through to
    // today's throwaway-conversation behaviour when unbound.
    const agent = getAgentByChannel(msg.channel, msg.threadKey);

    let convId: string;
    if (agent) {
      const existingConv = getPrimaryAgentConversation(agent.id);
      if (existingConv) {
        convId = existingConv.id;
      } else {
        convId = createConversation({ title: agent.name, agent_id: agent.id });
        await conductor.startConversation(convId, gatewayCwd(), {
          systemPrompt: agent.system_prompt,
        });
      }
    } else {
      // Reconnect to a mapped conversation across restarts, or create a new one.
      convId = getThreadConv(msg.channel, msg.threadKey) ?? '';
      if (!convId || !getConversation(convId)) {
        convId = createConversation({ title: `${msg.channel}:${msg.threadKey}` });
        await conductor.startConversation(convId, gatewayCwd());
        setThreadConv(msg.channel, msg.threadKey, convId);
      }
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
      unregisterMessages: () => {},
    };
    state.unregister = conductor.registerConsumer(convId, transcriptPath, makeConsumer(state));
    // Not part of the conductor injection seam — it touches no tmux/transcript,
    // just an in-process listener registry (see stream.ts), so it runs for real
    // in tests too.
    state.unregisterMessages = registerConversationMessageListener(
      convId,
      makeMessageListener(state),
    );
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
