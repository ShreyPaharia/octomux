/**
 * src/lib/orchestrator-api.ts
 *
 * REST + WebSocket client for the orchestrator chat backend (Task 1.7 / SHR-123).
 *
 * REST:
 *   POST   /api/orchestrator/conversations        — create a conversation
 *   GET    /api/orchestrator/conversations        — list conversations
 *   GET    /api/orchestrator/conversations/:id   — get a conversation
 *   GET    /api/orchestrator/conversations/:id/messages  — list messages
 *
 * WebSocket:
 *   /ws/orchestrator/:convId
 *
 * The client follows the pointers-not-contents discipline:
 * it passes through ws events as-is and never fetches/inlines artifact bodies.
 */

const BASE = '/api/orchestrator';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Conductor-leanness stats returned by GET /api/orchestrator/conversations/:id/usage (§6.7). */
export interface ConversationUsage {
  conversation_id: string;
  tasks_spawned: number;
  tool_calls: number;
  started_at: string;
  last_activity_at: string;
}

export interface OrchestratorConversation {
  id: string;
  title: string;
  tmux_window: string | null;
  claude_session_id: string | null;
  transcript_path: string | null;
  status: string;
  /** 1 when this conversation is in global-monitor mode, 0 otherwise. */
  is_global_monitor: number;
  created_at: string;
  updated_at: string;
}

export interface OrchestratorMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string; // JSON text of content blocks
  created_at: string;
}

/** A normalized message suitable for display in the MessageThread. */
export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** All server→client ws event shapes (§ stream.ts). */
export type WsIncomingEvent =
  | { type: 'message'; role: 'user' | 'assistant'; text: string; id?: string }
  | { type: 'card'; id: string; command: string; args: Record<string, unknown> }
  | { type: 'tool'; id: string; tool_name: string; input: unknown }
  | { type: 'status'; status: string }
  | { type: 'error'; error: string };

/** Client→server ws events. */
export type WsOutgoingEvent =
  | { type: 'user_turn'; text: string }
  | {
      type: 'card_decision';
      card_id: string;
      decision: 'approve' | 'edit' | 'reject' | 'respond';
      /** Edited command args (present when decision='edit'). */
      args?: Record<string, unknown>;
      /** Follow-up message text (present when decision='respond'). */
      text?: string;
      /** Whether to persist an always-allow rule for this command. */
      always_allow?: boolean;
    };

// ─── REST helpers ─────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((b as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ─── API surface ──────────────────────────────────────────────────────────────

export const orchestratorApi = {
  /** List all conversations (most-recently-updated first). */
  listConversations(): Promise<OrchestratorConversation[]> {
    return get('/conversations');
  },

  /** Get a single conversation by ID. */
  getConversation(id: string): Promise<OrchestratorConversation> {
    return get(`/conversations/${id}`);
  },

  /** Create a new conversation. */
  createConversation(title: string): Promise<OrchestratorConversation> {
    return post('/conversations', { title });
  },

  /** List messages for a conversation (used to populate history). */
  listMessages(conversationId: string): Promise<OrchestratorMessage[]> {
    return get(`/conversations/${conversationId}/messages`);
  },

  /**
   * Toggle global-monitor mode on a conversation.
   * If the conversation is already the global monitor, clears it.
   * Otherwise, designates it as the global monitor (clearing any previous one).
   */
  toggleGlobalMonitor(conversationId: string): Promise<{ is_global_monitor: boolean }> {
    return post(`/conversations/${conversationId}/global-monitor`, {});
  },

  /**
   * Fetch conductor-leanness usage stats for a conversation (§6.7).
   * Returns tasks_spawned + tool_calls counters and timestamps.
   */
  getUsage(conversationId: string): Promise<ConversationUsage> {
    return get(`/conversations/${conversationId}/usage`);
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a stored OrchestratorMessage into a DisplayMessage.
 * The content field is a JSON array of content blocks; we join text blocks.
 */
export function parseMessage(msg: OrchestratorMessage): DisplayMessage {
  let text = '';
  try {
    const blocks = JSON.parse(msg.content) as Array<{ type: string; text?: string }>;
    text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  } catch {
    text = msg.content;
  }
  return {
    id: msg.id,
    role: (msg.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    text,
  };
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

/** Connection lifecycle states surfaced to the UI (SHR-162). */
export type WsConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface OrchestratorWsOptions {
  onMessage: (event: WsIncomingEvent) => void;
  /** Called on every connection-state transition (drives the status pill). */
  onStatusChange?: (state: WsConnectionState) => void;
  /**
   * Called after a *reconnect* succeeds (not the first connect). The caller
   * should re-fetch history to backfill any messages missed while offline.
   */
  onReconnect?: () => void;
  onError?: (err: Event) => void;
}

export interface OrchestratorWsHandle {
  /** Send an event. Returns false when the socket is not currently open. */
  send: (event: WsOutgoingEvent) => boolean;
  /** Close the socket and stop reconnecting. */
  close: () => void;
}

/** Exponential backoff schedule for reconnect attempts (ms), capped at 15s. */
export const WS_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

const WS_OPEN = 1; // WebSocket.OPEN — literal so mocks don't need the static property

/**
 * Open a resilient WebSocket connection to `/ws/orchestrator/:convId`.
 *
 * Auto-reconnects with exponential backoff on an unexpected drop (a dropped
 * socket no longer forces a full page refresh — SHR-162). Surfaces every
 * connection-state transition via onStatusChange and signals onReconnect after
 * a successful reconnect so the caller can replay history. A user-initiated
 * close() stops reconnection.
 */
export function openOrchestratorWs(
  convId: string,
  opts: OrchestratorWsOptions,
): OrchestratorWsHandle {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/orchestrator/${convId}`;

  let ws: WebSocket | null = null;
  let closedByUser = false;
  let hasConnected = false; // distinguishes the first connect from a reconnect
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: WsConnectionState) => opts.onStatusChange?.(s);

  function scheduleReconnect(): void {
    if (closedByUser) return;
    const delay = WS_RECONNECT_DELAYS_MS[Math.min(attempt, WS_RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    setStatus(hasConnected ? 'reconnecting' : 'connecting');
    ws = new WebSocket(url);

    ws.onopen = () => {
      attempt = 0;
      const wasReconnect = hasConnected;
      hasConnected = true;
      setStatus('open');
      if (wasReconnect) opts.onReconnect?.();
    };

    ws.onclose = () => {
      if (closedByUser) {
        setStatus('closed');
        return;
      }
      // Unexpected drop — reconnect with backoff (no page refresh needed).
      scheduleReconnect();
    };

    ws.onerror = (err) => opts.onError?.(err);

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as WsIncomingEvent;
        opts.onMessage(data);
      } catch {
        // ignore malformed messages
      }
    };
  }

  connect();

  return {
    send(event: WsOutgoingEvent): boolean {
      if (ws && ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(event));
        return true;
      }
      return false;
    },
    close(): void {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      setStatus('closed');
    },
  };
}
