/**
 * src/pages/OrchestratorPage.tsx
 *
 * Route: /orchestrator
 *
 * Orchestrator chat UI (Tasks 1.7 / SHR-123, 2.6 / SHR-129, 5.1 / SHR-136).
 *
 * Layout:
 *   Left:   conversation list + "New conversation" button + global-monitor toggle
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
 *   inlined content. PlanCards receive only the artifact_url pointer and
 *   fetch the plan body browser-side; the orchestrator LLM never sees the body.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MessageThread, type ThreadMessage } from '../components/orchestrator/MessageThread';
import { PlanCard } from '../components/orchestrator/PlanCard';
import { ActionCard, type ActionCardDecision } from '../components/orchestrator/ActionCard';
import { ConversationList } from '../components/orchestrator/ConversationList';
import {
  orchestratorApi,
  openOrchestratorWs,
  parseMessage,
  type OrchestratorConversation,
  type WsIncomingEvent,
  type WsOutgoingEvent,
} from '../lib/orchestrator-api';
import { cn } from '@/lib/utils';

// ─── Thread item types ────────────────────────────────────────────────────────

/** A plan-approval card that appears inline in the message thread. */
interface PlanCardItem {
  kind: 'plan-card';
  id: string;
  taskId: string;
  planPath: string;
  artifactUrl: string;
  /** resolved once the user decides; removes the card from the thread */
  resolved: boolean;
}

/**
 * An action card for a gated write-command (Task 3.3 / SHR-132).
 * Rendered by ActionCard; user can Approve/Edit/Reject/Respond.
 */
interface ActionCardItem {
  kind: 'action-card';
  id: string;
  command: string;
  args: Record<string, unknown>;
  /** true when the command is in the always-ask (destructive) tier */
  alwaysAsk?: boolean;
  /** resolved once the user decides; removes the card from the thread */
  resolved: boolean;
}

/** A union of everything that can appear in the thread. */
type ThreadItem = ThreadMessage | PlanCardItem | ActionCardItem;

const SIDEBAR_WIDTH = 240;
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

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

// ─── MixedThread ─────────────────────────────────────────────────────────────

/**
 * Renders the thread: a mix of chat messages and inline cards.
 * ThreadMessages are delegated to MessageThread; cards are rendered inline.
 */
interface MixedThreadProps {
  items: ThreadItem[];
  onCardDecision: (d: ActionCardDecision) => void;
}

function MixedThread({ items, onCardDecision }: MixedThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        aria-live="polite"
        aria-label="Message thread"
      >
        No messages yet. Start a conversation below.
      </div>
    );
  }

  // Collect contiguous message runs to pass to MessageThread in batches;
  // cards break the run and are rendered inline.
  const rendered: ReactNode[] = [];
  let msgBatch: ThreadMessage[] = [];

  function flushBatch() {
    if (msgBatch.length === 0) return;
    const key = msgBatch[0].id;
    rendered.push(<MessageThread key={`msg-batch-${key}`} messages={msgBatch} />);
    msgBatch = [];
  }

  for (const item of items) {
    if ('role' in item) {
      // It's a ThreadMessage
      msgBatch.push(item as ThreadMessage);
    } else if (item.kind === 'plan-card' && !item.resolved) {
      flushBatch();
      rendered.push(
        <div key={item.id} className="px-4 py-2">
          <PlanCard
            cardId={item.id}
            taskId={item.taskId}
            planPath={item.planPath}
            artifactUrl={item.artifactUrl}
            onDecision={({ decision, card_id }) =>
              onCardDecision({ card_id, decision: decision as 'approve' | 'reject' })
            }
          />
        </div>,
      );
    } else if (item.kind === 'action-card' && !item.resolved) {
      flushBatch();
      rendered.push(
        <div key={item.id} className="px-4 py-2">
          <ActionCard
            cardId={item.id}
            command={item.command}
            args={item.args}
            alwaysAsk={item.alwaysAsk}
            onDecision={onCardDecision}
          />
        </div>,
      );
    }
  }
  flushBatch();

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto"
      role="log"
      aria-label="Message thread"
      aria-live="polite"
    >
      {rendered}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

// ─── OrchestratorPage ─────────────────────────────────────────────────────────

export default function OrchestratorPage() {
  const [conversations, setConversations] = useState<OrchestratorConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  /** Mixed thread of messages + inline cards. */
  const [items, setItems] = useState<ThreadItem[]>([]);
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
    setItems([]);
    setWsReady(false);

    // Load message history
    try {
      const history = await orchestratorApi.listMessages(convId);
      const displayMsgs: ThreadItem[] = history.map(parseMessage);
      setItems(displayMsgs);
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
          setItems((prev) => {
            // Avoid duplicate message ids (history + ws replay)
            if (msg.id && prev.some((m) => 'id' in m && m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        } else if (event.type === 'card') {
          // Dispatch the right card variant based on command
          if (event.command === 'approve-plan') {
            const args = event.args as {
              task_id?: string;
              plan_path?: string;
              artifact_url?: string;
            };
            const card: PlanCardItem = {
              kind: 'plan-card',
              id: event.id,
              taskId: args.task_id ?? '',
              planPath: args.plan_path ?? 'plan.json',
              artifactUrl: args.artifact_url ?? '',
              resolved: false,
            };
            setItems((prev) => {
              if (prev.some((i) => 'id' in i && i.id === card.id)) return prev;
              return [...prev, card];
            });
          } else {
            // Gated write-command card (Task 3.3) — render as ActionCard
            const alwaysAsk = (event.args as { always_ask?: boolean }).always_ask === true;
            const card: ActionCardItem = {
              kind: 'action-card',
              id: event.id,
              command: event.command,
              // Strip the always_ask meta-field from the displayed args
              args: Object.fromEntries(
                Object.entries(event.args).filter(([k]) => k !== 'always_ask'),
              ),
              alwaysAsk,
              resolved: false,
            };
            setItems((prev) => {
              if (prev.some((i) => 'id' in i && i.id === card.id)) return prev;
              return [...prev, card];
            });
          }
        }
        // status, error events are handled in Phase 3+
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

  // ─── Toggle global-monitor mode ──────────────────────────────────────────

  const handleToggleMonitor = useCallback(async (convId: string) => {
    try {
      const result = await orchestratorApi.toggleGlobalMonitor(convId);
      // Update conversations list to reflect the new global-monitor state.
      // At most one conversation can be global-monitor at a time, so we must
      // clear the flag on all others when enabling.
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id === convId) {
            return { ...c, is_global_monitor: result.is_global_monitor ? 1 : 0 };
          }
          // Clear global-monitor on other conversations when enabling one
          if (result.is_global_monitor) {
            return { ...c, is_global_monitor: 0 };
          }
          return c;
        }),
      );
    } catch {
      // silent — network errors are temporary
    }
  }, []);

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
    setItems((prev) => [...prev, msg]);
  }, []);

  // ─── Card decision ───────────────────────────────────────────────────────

  const handleCardDecision = useCallback((d: ActionCardDecision) => {
    if (!wsRef.current) return;
    const { card_id, decision, args, text, always_allow } = d;

    if (decision === 'respond' && text) {
      // Respond injects a free-text follow-up as a user turn
      wsRef.current.send({ type: 'user_turn', text });
      const msg: ThreadMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        text,
      };
      setItems((prev) => [...prev, msg]);
      return;
    }

    // approve / edit / reject → card_decision event
    const outgoing: WsOutgoingEvent = {
      type: 'card_decision',
      card_id,
      decision,
      ...(args !== undefined ? { args } : {}),
      ...(always_allow !== undefined ? { always_allow } : {}),
    };
    wsRef.current.send(outgoing);

    // Mark the card as resolved so it disappears from the thread
    setItems((prev) =>
      prev.map((item) => {
        if (!('kind' in item)) return item;
        if ((item.kind === 'plan-card' || item.kind === 'action-card') && item.id === card_id) {
          return { ...item, resolved: true };
        }
        return item;
      }),
    );
  }, []);

  // ─── Expose messages for tests (backward compat) ─────────────────────────

  // The existing OrchestratorPage tests reference `messages` via the
  // MessageThread render; we use MixedThread but keep the legacy path for
  // pure message rendering via MessageThread when there are no cards.
  // This is transparent to the test suite since MixedThread still renders
  // MessageThread internally for message runs.

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Page heading (visually hidden but accessible) */}
      <h1 className="sr-only">Orchestrator</h1>

      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <div
          className="border-r border-[rgba(255,255,255,0.08)]"
          style={{ width: SIDEBAR_WIDTH, minWidth: SIDEBAR_WIDTH }}
        >
          <ConversationList
            conversations={conversations}
            activeId={activeConvId}
            onSelect={openConversation}
            onNew={handleNewConversation}
            onToggleMonitor={handleToggleMonitor}
            loading={loadingConvs}
          />
        </div>

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

              {/* Mixed thread (messages + plan cards) */}
              <MixedThread items={items} onCardDecision={handleCardDecision} />

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
