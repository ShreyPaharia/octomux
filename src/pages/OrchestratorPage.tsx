/**
 * src/pages/OrchestratorPage.tsx
 *
 * Route: /orchestrator
 *
 * Minimal streamed orchestrator chat UI (Task 1.7 / SHR-123).
 *
 * Layout:
 *   Left:   conversation list + "New conversation" button
 *   Right:  message thread (streamed ws events) + message input
 *
 * Consumes the ws protocol from 1.6:
 *   server→client: { type:'message', role, text, id? }
 *                  { type:'card', id, command, args }
 *                  { type:'status', status }
 *                  { type:'error', error }
 *   client→server: { type:'user_turn', text }
 *                  { type:'card_decision', card_id, decision }
 *
 * Architecture (pointers-not-contents):
 *   The page never fetches or renders plan/diff file bodies.
 *   Tool-use and tool-result events arrive as 'message' type with text from
 *   the transcript; artifact paths surface as text in the thread, not as
 *   inlined content.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { MessageThread, type ThreadMessage } from '../components/orchestrator/MessageThread';
import {
  orchestratorApi,
  openOrchestratorWs,
  parseMessage,
  type OrchestratorConversation,
  type WsIncomingEvent,
  type WsOutgoingEvent,
} from '../lib/orchestrator-api';
import { cn } from '@/lib/utils';

const SIDEBAR_WIDTH = 240;
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

// ─── ConversationList ─────────────────────────────────────────────────────────

interface ConversationListProps {
  conversations: OrchestratorConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading: boolean;
}

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  loading,
}: ConversationListProps) {
  return (
    <div
      className="flex flex-col border-r border-[rgba(255,255,255,0.08)] bg-[#0e1116]"
      style={{ width: SIDEBAR_WIDTH, minWidth: SIDEBAR_WIDTH }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.45)]">
          Conversations
        </span>
        <button
          type="button"
          onClick={onNew}
          aria-label="New conversation"
          title="New conversation"
          data-testid="new-conversation-btn"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-[rgba(255,255,255,0.55)] hover:text-white',
            FOCUS_RING,
          )}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <line
              x1="7"
              y1="1"
              x2="7"
              y2="13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <line
              x1="1"
              y1="7"
              x2="13"
              y2="7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading && (
          <div className="px-4 py-2 text-xs text-[rgba(255,255,255,0.35)]">Loading...</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="px-4 py-2 text-xs text-[rgba(255,255,255,0.35)]">
            No conversations yet.
          </div>
        )}
        {conversations.map((conv) => {
          const isActive = conv.id === activeId;
          return (
            <button
              key={conv.id}
              type="button"
              onClick={() => onSelect(conv.id)}
              aria-current={isActive ? 'true' : undefined}
              data-testid={`conv-row-${conv.id}`}
              className={cn(
                'flex w-full items-center truncate rounded-lg px-3 py-2 text-left text-xs transition-colors',
                isActive
                  ? 'bg-[rgba(59,130,246,0.14)] font-semibold text-[#3B82F6]'
                  : 'text-[rgba(255,255,255,0.65)] hover:bg-[rgba(255,255,255,0.04)] hover:text-white',
                FOCUS_RING,
              )}
              style={{ margin: '1px 8px', width: 'calc(100% - 16px)' }}
            >
              <span className="truncate">{conv.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── ChatInput ────────────────────────────────────────────────────────────────

interface ChatInputProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

function ChatInput({ onSubmit, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleInput = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-[rgba(255,255,255,0.08)] px-4 py-3"
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        disabled={disabled}
        placeholder="Message orchestrator (Enter to send, Shift+Enter for newline)"
        rows={1}
        aria-label="Message input"
        className={cn(
          'flex-1 resize-none overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-4 py-2.5 text-sm text-foreground placeholder:text-[rgba(255,255,255,0.3)] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        style={{ minHeight: 44, maxHeight: 160 }}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#3B82F6] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40',
          FOCUS_RING,
        )}
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
  );
}

// ─── OrchestratorPage ─────────────────────────────────────────────────────────

export default function OrchestratorPage() {
  const [conversations, setConversations] = useState<OrchestratorConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [wsReady, setWsReady] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);

  /** Ref to the ws send/close handle so we can send user turns. */
  const wsRef = useRef<{ send: (e: WsOutgoingEvent) => void; close: () => void } | null>(null);

  // ─── Load conversation list ──────────────────────────────────────────────

  const loadConversations = useCallback(async () => {
    try {
      const convs = await orchestratorApi.listConversations();
      setConversations(convs);
    } catch {
      // silent — network errors are temporary
    } finally {
      setLoadingConvs(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // ─── Open a conversation ─────────────────────────────────────────────────

  const openConversation = useCallback(async (convId: string) => {
    // Close any existing ws connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setActiveConvId(convId);
    setMessages([]);
    setWsReady(false);

    // Load message history
    try {
      const history = await orchestratorApi.listMessages(convId);
      const displayMsgs = history.map(parseMessage);
      setMessages(displayMsgs);
    } catch {
      // No history yet is fine
    }

    // Open ws
    const handle = openOrchestratorWs(convId, {
      onOpen: () => setWsReady(true),
      onClose: () => setWsReady(false),
      onMessage: (event: WsIncomingEvent) => {
        if (event.type === 'message') {
          const msg: ThreadMessage = {
            id: event.id ?? `ws-${Date.now()}-${Math.random()}`,
            role: event.role,
            text: event.text,
          };
          setMessages((prev) => {
            // Avoid duplicate message ids (history + ws replay)
            if (msg.id && prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
        // card, status, error events are handled in Phase 3+
      },
    });

    wsRef.current = handle;
  }, []);

  // Cleanup ws on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // ─── Create a new conversation ───────────────────────────────────────────

  const handleNewConversation = useCallback(async () => {
    if (creatingConv) return;
    setCreatingConv(true);
    try {
      const conv = await orchestratorApi.createConversation('New conversation');
      setConversations((prev) => [conv, ...prev]);
      await openConversation(conv.id);
    } catch {
      // silent
    } finally {
      setCreatingConv(false);
    }
  }, [creatingConv, openConversation]);

  // ─── Send user turn ──────────────────────────────────────────────────────

  const handleSend = useCallback((text: string) => {
    if (!wsRef.current) return;
    wsRef.current.send({ type: 'user_turn' as const, text });
    // Optimistically add the user message to the thread
    const msg: ThreadMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Page heading (visually hidden but accessible) */}
      <h1 className="sr-only">Orchestrator</h1>

      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <ConversationList
          conversations={conversations}
          activeId={activeConvId}
          onSelect={openConversation}
          onNew={handleNewConversation}
          loading={loadingConvs}
        />

        {/* Chat area */}
        <div className="flex min-h-0 flex-1 flex-col">
          {activeConvId ? (
            <>
              {/* Thread header */}
              <div className="flex items-center border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {conversations.find((c) => c.id === activeConvId)?.title ?? 'Conversation'}
                </h2>
                {wsReady && (
                  <span
                    aria-label="Connected"
                    title="WebSocket connected"
                    className="ml-2 h-2 w-2 shrink-0 rounded-full bg-[#22C55E]"
                  />
                )}
              </div>

              {/* Message thread */}
              <MessageThread messages={messages} className="flex-1" />

              {/* Input */}
              <ChatInput onSubmit={handleSend} />
            </>
          ) : (
            <EmptyState onNew={handleNewConversation} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(59,130,246,0.12)]">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#3B82F6"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">No conversation selected</p>
        <p className="mt-1 text-xs text-[rgba(255,255,255,0.45)]">
          Select a conversation from the list or start a new one.
        </p>
      </div>
      <button
        type="button"
        onClick={onNew}
        className={cn(
          'rounded-lg bg-[#3B82F6] px-4 py-2 text-sm font-medium text-white hover:opacity-90',
          FOCUS_RING,
        )}
      >
        New conversation
      </button>
    </div>
  );
}
