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

export interface OrchestratorConversation {
  id: string;
  title: string;
  tmux_window: string | null;
  claude_session_id: string | null;
  transcript_path: string | null;
  status: string;
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
  | { type: 'status'; status: string }
  | { type: 'error'; error: string };

/** Client→server ws events. */
export type WsOutgoingEvent =
  | { type: 'user_turn'; text: string }
  | {
      type: 'card_decision';
      card_id: string;
      decision: 'approve' | 'reject';
      args?: Record<string, unknown>;
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

export interface OrchestratorWsOptions {
  onMessage: (event: WsIncomingEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
}

/**
 * Open a WebSocket connection to `/ws/orchestrator/:convId`.
 * Returns a send function and a cleanup function.
 */
export function openOrchestratorWs(
  convId: string,
  opts: OrchestratorWsOptions,
): { send: (event: WsOutgoingEvent) => void; close: () => void } {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws/orchestrator/${convId}`;

  const ws = new WebSocket(url);

  ws.onopen = () => opts.onOpen?.();
  ws.onclose = () => opts.onClose?.();
  ws.onerror = (err) => opts.onError?.(err);

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string) as WsIncomingEvent;
      opts.onMessage(data);
    } catch {
      // ignore malformed messages
    }
  };

  const WS_OPEN = 1; // WebSocket.OPEN — using the literal so mocks don't need the static property

  return {
    send(event: WsOutgoingEvent): void {
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify(event));
      }
    },
    close(): void {
      ws.close();
    },
  };
}
