/**
 * src/components/AgentSessionChat.tsx
 *
 * Standalone live chat/CLI view for one agent conductor session.
 *
 * Deliberately NOT built from `src/components/orchestrator/*` or
 * `src/pages/OrchestratorPage.tsx` — those stay untouched for the orchestrator
 * surface. This is a new, self-contained component; duplication vs. the
 * orchestrator page's chat rendering is intentional (spec/agents-feature.md).
 *
 * It does reuse the plain data-layer client (`orchestratorApi`, `parseMessage`)
 * from `src/lib/orchestrator-api.ts` — that file is a REST/WS client, not a
 * page or a rendering component, so pulling history/parsing off it here does
 * not couple this component to the orchestrator page.
 *
 * Protocol (mirrors `/ws/orchestrator/:convId`, see OrchestratorPage.tsx):
 *   server->client: { type:'message', role, text, id? }
 *                   { type:'card'|'tool'|'status', ... } — collapsed/ignored here
 *                   { type:'error', error }
 *   client->server: { type:'user_turn', text }
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { cn } from '@/lib/utils';
import { orchestratorApi, parseMessage, type DisplayMessage } from '@/lib/orchestrator-api';

type ConnectionState = 'connecting' | 'open' | 'closed';

// WebSocket.OPEN as a literal so test mocks don't need to define the static
// property (mirrors the convention in src/lib/orchestrator-api.ts).
const WS_OPEN = 1;

interface WsIncomingEvent {
  type: 'message' | 'card' | 'tool' | 'status' | 'error';
  role?: 'user' | 'assistant';
  text?: string;
  id?: string;
  error?: string;
}

export interface AgentSessionChatProps {
  convId: string;
}

export function AgentSessionChat({ convId }: AgentSessionChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    orchestratorApi
      .listMessages(convId)
      .then((history) => {
        if (!cancelled) setMessages(history.map(parseMessage));
      })
      .catch(() => {
        // history is best-effort; the live socket carries new messages regardless
      });
    return () => {
      cancelled = true;
    };
  }, [convId]);

  useEffect(() => {
    setConnection('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/orchestrator/${convId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnection('open');
    ws.onclose = () => setConnection('closed');
    ws.onerror = () => setConnection('closed');
    ws.onmessage = (ev) => {
      let event: WsIncomingEvent;
      try {
        event = JSON.parse(ev.data as string) as WsIncomingEvent;
      } catch {
        return;
      }
      if (event.type === 'message' && event.role) {
        const msg: DisplayMessage = {
          id: event.id ?? `ws-${Date.now()}-${Math.random()}`,
          role: event.role,
          text: event.text ?? '',
        };
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      } else if (event.type === 'error') {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            text: `⚠️ ${event.error ?? 'Unknown error'}`,
          },
        ]);
      }
      // 'card' / 'tool' / 'status' events are gracefully ignored here — the
      // agent session view is a plain chat/CLI, no action-card choreography.
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [convId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WS_OPEN) return;
    ws.send(JSON.stringify({ type: 'user_turn', text }));
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: 'user', text }]);
    setInput('');
  }, [input]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      send();
    },
    [send],
  );

  const connectionLabel = useMemo(
    () => ({ connecting: 'connecting', open: 'live', closed: 'offline' })[connection],
    [connection],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-session-chat">
      <div className="flex items-center justify-between border-b border-glass-edge px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground">Session</span>
        <span
          role="status"
          data-testid="agent-session-connection"
          className="flex items-center gap-1.5 text-[11px] text-muted-soft"
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              connection === 'open' && 'bg-emerald-500',
              connection === 'connecting' && 'animate-pulse bg-amber-500',
              connection === 'closed' && 'bg-muted-foreground',
            )}
          />
          {connectionLabel}
        </span>
      </div>

      <div className="flex-1 overflow-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {messages.map((msg) => (
            <div
              key={msg.id}
              data-role={msg.role}
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-xl px-4 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'ml-auto bg-primary text-primary-foreground'
                  : 'mr-auto bg-glass-l1 text-foreground',
              )}
            >
              {msg.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 border-t border-glass-edge px-4 py-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message this agent (Enter to send, Shift+Enter for newline)"
          rows={1}
          aria-label="Message input"
          className="flex-1 resize-none rounded-xl border border-glass-edge bg-glass-l1 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          aria-label="Send message"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 8h12M10 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>
    </div>
  );
}
