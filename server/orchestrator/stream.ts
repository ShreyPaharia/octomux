/**
 * server/orchestrator/stream.ts
 *
 * Stream wiring for the orchestrator chat (Task 1.6 / SHR-122).
 *
 * Responsibilities:
 *  - Tail the conversation's transcript JSONL via `tailTranscript`, normalize
 *    each ChatEvent into a ws `OrchestratorWsEvent`, persist messages to
 *    `orchestrator_messages`, and push them to the connected WebSocket client.
 *  - Route `user_turn` messages from the client → `runner.sendTurn` (send-keys).
 *  - WebSocket upgrade handler for `/ws/orchestrator/:convId`.
 *
 * WS protocol (server → client):
 *   { type: 'message', role: 'user'|'assistant', text: string, id?: string }
 *   { type: 'card', id: string, command: string, args: object }
 *   { type: 'status', status: string }
 *   { type: 'error', error: string }
 *
 * WS protocol (client → server):
 *   { type: 'user_turn', text: string }
 *   { type: 'card_decision', card_id: string, decision: 'approve'|'reject', args?: object }
 *
 * Architecture note (pointers-not-contents):
 *   The stream layer passes normalized chat events from the transcript — it never
 *   reads plan/diff file bodies and never inlines artifact contents. Tool results
 *   containing artifact paths are passed through as-is (they contain paths, not bodies).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { childLogger } from '../logger.js';
import { getConversation, appendMessage, listMessages, listPendingCards } from './store.js';
import type { ActionCard } from './store.js';
import { sendTurn } from './runner.js';
import { tailTranscript } from './transcript.js';
import type { ChatEvent } from './transcript.js';
import type { StopFn } from './transcript.js';
import { executeCard } from './gate.js';

const logger = childLogger('orchestrator/stream');

// ─── Types ────────────────────────────────────────────────────────────────────

/** A message event pushed to the ws client. */
export interface WsMessageEvent {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  id?: string;
}

/** An action card pushed to the ws client. */
export interface WsCardEvent {
  type: 'card';
  id: string;
  command: string;
  args: Record<string, unknown>;
}

/** A status update pushed to the ws client. */
export interface WsStatusEvent {
  type: 'status';
  status: string;
}

/** An error event pushed to the ws client. */
export interface WsErrorEvent {
  type: 'error';
  error: string;
}

/**
 * A conductor tool-call event (SHR-161). Forwarded live so the UI can render a
 * collapsible tool card distinct from prose. Not persisted (ephemeral, like
 * cards) — the durable record is the assistant prose around it.
 */
export interface WsToolEvent {
  type: 'tool';
  id: string;
  tool_name: string;
  input: unknown;
}

/** Union of all server → client ws events. */
export type OrchestratorWsEvent =
  | WsMessageEvent
  | WsCardEvent
  | WsStatusEvent
  | WsErrorEvent
  | WsToolEvent;

/** A message received from the ws client. */
export interface WsClientTurn {
  type: 'user_turn';
  text: string;
}

/** A card decision received from the ws client. */
export interface WsClientCardDecision {
  type: 'card_decision';
  card_id: string;
  decision: 'approve' | 'edit' | 'reject' | 'respond';
  /** For 'edit': the user-adjusted command/args to run instead. */
  edited_input?: Record<string, unknown>;
  /** For 'reject'/'respond': optional free-text to inject. */
  respond_text?: string;
}

export type WsClientMessage = WsClientTurn | WsClientCardDecision;

/** Callback type for pushing a serialized ws message to a client. */
export type PushFn = (message: string) => void;

// ─── Per-conversation client + consumer registry ─────────────────────────────

/** A raw-ChatEvent consumer of a conversation's transcript (WS bridge or gateway). */
export type ChatConsumer = (event: ChatEvent) => void;

/**
 * Map of conversation_id → Set of active push functions.
 * Multiple clients may be connected to the same conversation (tab duplication, etc).
 */
const convClients = new Map<string, Set<PushFn>>();

/**
 * conversation_id → raw-ChatEvent consumers. Both the WS bridge and the gateway
 * register here; the transcript tail is refcounted by this set (starts on the
 * first consumer, stops on the last) so a phone DM with no dashboard open is
 * still read by the gateway's consumer.
 */
const convConsumers = new Map<string, Set<ChatConsumer>>();

/** Active transcript tail stop functions, keyed by conversation_id. */
const convTails = new Map<string, StopFn>();

/** In-flight tail-start promises — dedupe concurrent registrations for one conv. */
const convTailStarting = new Map<string, Promise<void>>();

/** conversation_id → unregister fn for the shared WS-bridge consumer. */
const convWsUnregister = new Map<string, () => void>();

function addClient(convId: string, push: PushFn, transcriptPath: string | null): void {
  let set = convClients.get(convId);
  if (!set) {
    set = new Set();
    convClients.set(convId, set);
  }
  set.add(push);

  // Register a single shared WS-bridge consumer for this conversation on the
  // first client — it maps raw ChatEvents to ws events and fans them out to all
  // connected clients. (One consumer per conv, not per client.)
  if (transcriptPath && !convWsUnregister.has(convId)) {
    const bridge: ChatConsumer = (chatEvent) => {
      const wsEvent = chatEventToWsEvent(chatEvent);
      if (!wsEvent) return;
      const clients = convClients.get(convId);
      if (!clients || clients.size === 0) return;
      const msg = JSON.stringify(wsEvent);
      for (const p of clients) p(msg);
    };
    convWsUnregister.set(convId, registerTranscriptConsumer(convId, transcriptPath, bridge));
  }
}

function removeClient(convId: string, push: PushFn): void {
  const set = convClients.get(convId);
  if (!set) return;
  set.delete(push);
  if (set.size === 0) {
    convClients.delete(convId);
    // Drop the WS bridge; the tail keeps running iff the gateway still consumes.
    const unreg = convWsUnregister.get(convId);
    if (unreg) {
      unreg();
      convWsUnregister.delete(convId);
    }
  }
}

// ─── persistAndPush ───────────────────────────────────────────────────────────

/**
 * Persist a `message`-type event to `orchestrator_messages` and push the
 * serialized event to the provided push function.
 *
 * `card` and `status` events are pushed but NOT stored in orchestrator_messages
 * (they are not part of the persistent conversation history).
 *
 * @param convId - Conversation ID
 * @param event  - The OrchestratorWsEvent to handle
 * @param push   - Callback to send the serialized JSON to the ws client
 */
export function persistAndPush(convId: string, event: OrchestratorWsEvent, push: PushFn): void {
  // Persist message events only
  if (event.type === 'message') {
    const contentBlocks = [{ type: 'text', text: event.text }];
    appendMessage({
      conversation_id: convId,
      role: event.role,
      content: JSON.stringify(contentBlocks),
    });
    logger.debug(
      { conversation_id: convId, role: event.role, textLen: event.text.length },
      'stream: message persisted',
    );
  }

  push(JSON.stringify(event));
}

// ─── chatEventToWsEvent ───────────────────────────────────────────────────────

/**
 * Normalize a ChatEvent from the transcript into an OrchestratorWsEvent, or
 * return null for events that should not be forwarded to the client (e.g.
 * compact_boundary system lines).
 */
export function chatEventToWsEvent(event: ChatEvent): OrchestratorWsEvent | null {
  switch (event.type) {
    case 'user':
      // Skip empty turns (e.g. a turn that carried only a tool_result) — they'd
      // render as blank bubbles.
      if (!event.text.trim()) return null;
      return { type: 'message', role: 'user', text: event.text, id: event.uuid };
    case 'assistant':
      // Assistant lines that are pure tool_use / thinking have no text — skip
      // them so the thread doesn't fill with empty assistant bubbles.
      if (!event.text.trim()) return null;
      return { type: 'message', role: 'assistant', text: event.text, id: event.uuid };
    case 'tool_use':
      // Forward conductor tool calls so the UI can render a tool card distinct
      // from prose (SHR-161). Ephemeral — broadcast live, not persisted.
      return {
        type: 'tool',
        id: event.toolUseId,
        tool_name: event.toolName,
        input: event.input,
      };
    case 'tool_result':
      // Tool results are not forwarded to the client (the assistant prose that
      // follows summarizes them; pointers-not-contents discipline).
      return null;
    case 'system':
      // Skip compact_boundary and other system lines
      return null;
    default:
      return null;
  }
}

// ─── Card rehydration on (re)connect (SHR-161 follow-up) ───────────────────────

/**
 * Reconstruct the `card` ws event for a persisted pending action_cards row, so a
 * client that (re)connects or reloads re-renders the card instead of losing it.
 *
 * Cards are otherwise pushed exactly once, live, at phase-complete time — a
 * page reload or a silent ws auto-reconnect (SHR-162) would drop them, leaving
 * the run wedged on an invisible approval gate. Returns null only if a row can't
 * be mapped (never expected for known tool_names).
 */
export function cardRowToWsEvent(card: ActionCard): WsCardEvent | null {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(card.input) as Record<string, unknown>;
  } catch {
    input = {};
  }
  const taskId = typeof input.task_id === 'string' ? input.task_id : '';
  const artifactUrl = (path: string) =>
    taskId
      ? `/api/orchestrator/artifact?task=${encodeURIComponent(taskId)}&path=${encodeURIComponent(path)}`
      : '';

  if (card.tool_name === 'approve-plan') {
    const planPath = typeof input.plan_path === 'string' ? input.plan_path : 'plan.json';
    return {
      type: 'card',
      id: card.id,
      command: 'approve-plan',
      args: { task_id: taskId, plan_path: planPath, artifact_url: artifactUrl(planPath) },
    };
  }
  if (card.tool_name === 'view-spec') {
    const specPath = typeof input.spec_path === 'string' ? input.spec_path : 'spec.md';
    return {
      type: 'card',
      id: card.id,
      command: 'view-spec',
      args: { task_id: taskId, spec_path: specPath, artifact_url: artifactUrl(specPath) },
    };
  }
  // Gated write-command card → render as a generic ActionCard (command = tool_name).
  return { type: 'card', id: card.id, command: card.tool_name, args: input };
}

/**
 * Send the durable conversation state to a (re)connecting client: persisted
 * messages first, then any still-pending cards. Idempotent on the client — card
 * ids are stable, so a live session that already has a card de-dupes the replay.
 */
export function replayConnectionState(convId: string, push: PushFn): void {
  // Persisted messages
  try {
    const history = listMessages(convId);
    for (const msg of history) {
      const contentBlocks = (() => {
        try {
          return JSON.parse(msg.content) as Array<{ type: string; text?: string }>;
        } catch {
          return [{ type: 'text', text: msg.content }];
        }
      })();
      const text = contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const histEvent: WsMessageEvent = {
        type: 'message',
        role: msg.role as 'user' | 'assistant',
        text,
        id: msg.id,
      };
      push(JSON.stringify(histEvent));
    }
  } catch (err) {
    logger.warn({ conversation_id: convId, err }, 'stream: failed to replay history');
  }

  // Pending cards (so a reload / reconnect re-surfaces the approval gate)
  try {
    for (const card of listPendingCards(convId)) {
      const ev = cardRowToWsEvent(card);
      if (ev) push(JSON.stringify(ev));
    }
  } catch (err) {
    logger.warn({ conversation_id: convId, err }, 'stream: failed to replay pending cards');
  }
}

// ─── Transcript tail (consumer-refcounted) ───────────────────────────────────

/**
 * Persist a user/assistant text ChatEvent to `orchestrator_messages` — ONCE per
 * conversation, at the tail level. Consumers (WS bridge, gateway) are
 * delivery-only, so two of them watching the same conversation never
 * double-persist. Empty-text lines (pure tool_use / tool_result carriers) are
 * skipped, matching `chatEventToWsEvent`.
 */
function persistChatEvent(convId: string, event: ChatEvent): void {
  if (event.type !== 'user' && event.type !== 'assistant') return;
  if (!event.text.trim()) return;
  try {
    const contentBlocks = [{ type: 'text', text: event.text }];
    appendMessage({
      conversation_id: convId,
      role: event.type,
      content: JSON.stringify(contentBlocks),
    });
  } catch (err) {
    logger.warn({ conversation_id: convId, err }, 'stream: failed to persist message');
  }
}

/**
 * Ensure a transcript tail is running for a conversation (idempotent, and
 * deduped across concurrent callers). The tail persists message events once and
 * broadcasts every raw ChatEvent to all registered consumers.
 */
async function ensureTail(convId: string, transcriptPath: string): Promise<void> {
  if (convTails.has(convId)) return;
  const inflight = convTailStarting.get(convId);
  if (inflight) return inflight;

  const start = (async () => {
    logger.info(
      { conversation_id: convId, transcript_path: transcriptPath },
      'stream: starting transcript tail',
    );
    const stop = await tailTranscript(
      transcriptPath,
      (chatEvent) => {
        persistChatEvent(convId, chatEvent);
        const set = convConsumers.get(convId);
        if (!set) return;
        for (const consumer of set) {
          try {
            consumer(chatEvent);
          } catch (err) {
            logger.warn({ conversation_id: convId, err }, 'stream: transcript consumer threw');
          }
        }
      },
      { startAtEnd: true },
    );
    // All consumers may have unregistered while we awaited — honor teardown.
    if (convConsumers.get(convId)?.size) {
      convTails.set(convId, stop);
      logger.debug({ conversation_id: convId }, 'stream: transcript tail started');
    } else {
      stop();
    }
  })();

  convTailStarting.set(convId, start);
  try {
    await start;
  } finally {
    convTailStarting.delete(convId);
  }
}

/**
 * Register a raw-ChatEvent consumer for a conversation, starting the transcript
 * tail if it isn't running. Returns an unregister fn; the tail stops when the
 * last consumer unregisters. This is the gateway's entry point — it lets a
 * non-WS owner receive assistant lines and turn-done boundaries with no browser
 * client connected.
 */
export function registerTranscriptConsumer(
  convId: string,
  transcriptPath: string,
  consumer: ChatConsumer,
): () => void {
  let set = convConsumers.get(convId);
  if (!set) {
    set = new Set();
    convConsumers.set(convId, set);
  }
  set.add(consumer);
  void ensureTail(convId, transcriptPath).catch((err) =>
    logger.warn({ conversation_id: convId, err }, 'stream: failed to start transcript tail'),
  );

  return () => {
    const s = convConsumers.get(convId);
    if (!s) return;
    s.delete(consumer);
    if (s.size === 0) {
      convConsumers.delete(convId);
      const stop = convTails.get(convId);
      if (stop) {
        stop();
        convTails.delete(convId);
        logger.debug({ conversation_id: convId }, 'stream: transcript tail stopped (no consumers)');
      }
    }
  };
}

// ─── dispatchUserTurn ─────────────────────────────────────────────────────────

/**
 * Deliver a user turn to the orchestrator session:
 *  1. Validate the conversation exists.
 *  2. Persist the turn to `orchestrator_messages`.
 *  3. Push the turn event back to the ws client (echo).
 *  4. Forward to `runner.sendTurn` (tmux send-keys).
 *
 * @param convId - Conversation ID
 * @param text   - User turn text
 * @param push   - Optional push callback for echoing the turn to the sender
 */
export async function dispatchUserTurn(convId: string, text: string, push: PushFn): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) {
    throw new Error(`conversation ${convId} not found`);
  }

  logger.debug({ conversation_id: convId, textLen: text.length }, 'stream: dispatching user turn');

  // Forward to the tmux session via send-keys. We do NOT echo/persist the turn
  // here — the transcript tail is the single source for all messages (the
  // session writes the user turn to the transcript, which the tail surfaces +
  // persists). Echoing here would duplicate the user message.
  void push;
  await sendTurn(convId, text);

  logger.debug({ conversation_id: convId }, 'stream: user turn sent to session');
}

// ─── WebSocket handler ────────────────────────────────────────────────────────

let wss: WebSocketServer;

/** Initialise the orchestrator WebSocket server (noServer mode). Call once at startup. */
export function setupOrchestratorWebSocket(): void {
  wss = new WebSocketServer({ noServer: true });
  logger.debug({}, 'stream: orchestrator WebSocket server initialised');
}

/**
 * Handle a WebSocket upgrade request for `/ws/orchestrator/:convId`.
 *
 * Returns true if the URL matched (and we took ownership of the upgrade),
 * false if it did not match (the caller should try another handler).
 */
export function handleOrchestratorUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const match = (req.url ?? '').match(/^\/ws\/orchestrator\/([^/?#]+)/);
  if (!match) return false;

  const convId = match[1]!;

  if (!wss) {
    logger.error(
      { conversation_id: convId },
      'stream: wss not initialised — call setupOrchestratorWebSocket()',
    );
    socket.destroy();
    return true;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    logger.info({ conversation_id: convId }, 'stream: ws client connected');

    // Push function for this specific client
    const push: PushFn = (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    };

    // Send conversation history on connect
    const conv = getConversation(convId);
    if (!conv) {
      push(JSON.stringify({ type: 'error', error: `conversation ${convId} not found` }));
      ws.close(1008, 'Conversation not found');
      return;
    }

    // Register the client (and, on the first client, the shared WS bridge + tail).
    addClient(convId, push, conv.transcript_path);

    // Replay persisted messages AND pending cards to the (re)connecting client.
    replayConnectionState(convId, push);

    ws.on('message', (data) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        push(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
        return;
      }

      if (msg.type === 'user_turn') {
        if (!msg.text?.trim()) {
          push(JSON.stringify({ type: 'error', error: 'text is required' }));
          return;
        }
        dispatchUserTurn(convId, msg.text, push).catch((err) => {
          const errMsg = (err as Error).message ?? 'unknown error';
          logger.warn({ conversation_id: convId, err }, 'stream: user_turn dispatch failed');
          push(JSON.stringify({ type: 'error', error: errMsg }));
        });
      } else if (msg.type === 'card_decision') {
        // Phase 3: gate card decision — Approve / Edit / Reject / Respond
        if (!msg.card_id) {
          push(JSON.stringify({ type: 'error', error: 'card_id is required' }));
          return;
        }
        executeCard({
          card_id: msg.card_id,
          decision: msg.decision,
          edited_input: msg.edited_input,
          respond_text: msg.respond_text,
        }).catch((err) => {
          const errMsg = (err as Error).message ?? 'unknown error';
          logger.warn(
            { conversation_id: convId, card_id: msg.card_id, err },
            'stream: card_decision failed',
          );
          push(JSON.stringify({ type: 'error', error: errMsg }));
        });
      } else {
        push(
          JSON.stringify({
            type: 'error',
            error: `unknown message type: ${String((msg as Record<string, unknown>).type)}`,
          }),
        );
      }
    });

    ws.on('close', () => {
      logger.info({ conversation_id: convId }, 'stream: ws client disconnected');
      removeClient(convId, push);
    });

    ws.on('error', (err) => {
      logger.warn({ conversation_id: convId, err }, 'stream: ws client error');
      removeClient(convId, push);
    });
  });

  return true;
}

/** Return the number of active ws clients for a conversation (for tests). */
export function getOrchestratorClientCount(convId: string): number {
  return convClients.get(convId)?.size ?? 0;
}

/**
 * Push a serialized ws message to all connected clients for a conversation.
 * Used by the supervisor to inject concise notes without going through the
 * transcript tail. Also persists message-type events to orchestrator_messages.
 *
 * The `message` parameter must be a serialized JSON string (OrchestratorWsEvent).
 */
export function pushToConversation(convId: string, message: string): void {
  // Persist if it's a message-type event
  try {
    const event = JSON.parse(message) as OrchestratorWsEvent;
    if (event.type === 'message') {
      const contentBlocks = [{ type: 'text', text: event.text }];
      appendMessage({
        conversation_id: convId,
        role: event.role,
        content: JSON.stringify(contentBlocks),
      });
    }
  } catch {
    // ignore parse errors — still push to clients
  }

  const set = convClients.get(convId);
  if (!set || set.size === 0) return;
  for (const push of set) {
    push(message);
  }
}

/** Stop all active transcript tails (for graceful shutdown). */
export function cleanupOrchestratorClients(): void {
  for (const [convId, stop] of convTails) {
    try {
      stop();
    } catch {
      // ignore
    }
    logger.debug({ conversation_id: convId }, 'stream: transcript tail stopped (cleanup)');
  }
  convTails.clear();
  convTailStarting.clear();
  convClients.clear();
  convConsumers.clear();
  convWsUnregister.clear();
}
