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
import { ToolCallCard } from '../components/orchestrator/ToolCallCard';
import { PlanCard } from '../components/orchestrator/PlanCard';
import { SpecCard } from '../components/orchestrator/SpecCard';
import { ActionCard, type ActionCardDecision } from '../components/orchestrator/ActionCard';
import { ConversationList } from '../components/orchestrator/ConversationList';
import { toast } from 'sonner';
import {
  orchestratorApi,
  openOrchestratorWs,
  parseMessage,
  type OrchestratorConversation,
  type ConversationUsage,
  type WsIncomingEvent,
  type WsOutgoingEvent,
  type WsConnectionState,
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
 * A read-only spec card for the workflow kind (SHR-143).
 * Rendered by SpecCard; no ws decision event — local dismiss only.
 */
interface SpecCardItem {
  kind: 'spec-card';
  id: string;
  taskId: string;
  specPath: string;
  artifactUrl: string;
  /** true when the user has locally dismissed the card */
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

/**
 * A conductor tool-call, rendered as a collapsible card distinct from prose
 * (SHR-161). Live/ephemeral — pushed from the transcript tail, not persisted.
 */
interface ToolCallItem {
  kind: 'tool-call';
  id: string;
  toolName: string;
  input: unknown;
}

/** A union of everything that can appear in the thread. */
type ThreadItem = ThreadMessage | PlanCardItem | SpecCardItem | ActionCardItem | ToolCallItem;

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
  onSpecCardDismiss: (cardId: string) => void;
  /** True while the orchestrator is processing a turn (shows a working indicator). */
  working?: boolean;
}

function MixedThread({
  items,
  onCardDecision,
  onSpecCardDismiss,
  working = false,
}: MixedThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length, working]);

  if (items.length === 0 && !working) {
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
    } else if (item.kind === 'tool-call') {
      flushBatch();
      rendered.push(
        <div key={item.id} className="px-4 py-1">
          <ToolCallCard toolName={item.toolName} input={item.input} />
        </div>,
      );
    } else if (item.kind === 'spec-card' && !item.resolved) {
      flushBatch();
      rendered.push(
        <div key={item.id} className="px-4 py-2">
          <SpecCard
            cardId={item.id}
            taskId={item.taskId}
            specPath={item.specPath}
            artifactUrl={item.artifactUrl}
            onDismiss={() => onSpecCardDismiss(item.id)}
          />
        </div>,
      );
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
      {working && <WorkingIndicator />}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

/** Animated "orchestrator is working" indicator shown while a turn is in flight. */
function WorkingIndicator() {
  return (
    <div
      className="flex items-center gap-2 px-4 py-3"
      aria-live="polite"
      aria-label="Orchestrator is working"
    >
      <span className="flex gap-1">
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground" />
      </span>
      <span className="text-xs text-muted-foreground">orchestrator is working…</span>
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
  /** WebSocket connection lifecycle state (drives the status pill, SHR-162). */
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  // True from when the user sends a turn until the orchestrator's next output
  // (a message or a card) arrives — drives the "working" indicator.
  const [working, setWorking] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);
  /** Conductor-leanness usage stats for the active conversation (§6.7). */
  const [usage, setUsage] = useState<ConversationUsage | null>(null);

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
    setWsState('connecting');
    setWorking(false);
    setUsage(null);

    // Load message history and usage stats in parallel
    const [historyResult, usageResult] = await Promise.allSettled([
      orchestratorApi.listMessages(convId),
      orchestratorApi.getUsage(convId),
    ]);

    if (historyResult.status === 'fulfilled') {
      setItems(historyResult.value.map(parseMessage));
    } else {
      toast.error('Could not load conversation history. Reconnecting may recover it.');
    }
    if (usageResult.status === 'fulfilled') {
      setUsage(usageResult.value);
    }

    // Re-fetch history and merge any messages missed while the socket was down.
    // Dedupes by id so already-rendered messages aren't duplicated.
    const replayHistory = async () => {
      try {
        const history = await orchestratorApi.listMessages(convId);
        const fresh = history.map(parseMessage);
        setItems((prev) => {
          const seen = new Set(prev.filter((i) => 'id' in i).map((i) => i.id));
          const additions = fresh.filter((m) => !seen.has(m.id));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      } catch {
        // best-effort backfill; the live socket will carry new messages anyway
      }
    };

    // Open ws
    const handle = openOrchestratorWs(convId, {
      onStatusChange: (state) => setWsState(state),
      onReconnect: () => {
        toast.success('Reconnected to orchestrator');
        void replayHistory();
      },
      onMessage: (event: WsIncomingEvent) => {
        // Any orchestrator output (message or card) ends the "working" state.
        setWorking(false);
        if (event.type === 'message') {
          const msg: ThreadMessage = {
            id: event.id ?? `ws-${Date.now()}-${Math.random()}`,
            role: event.role,
            text: event.text,
          };
          setItems((prev) => {
            // Avoid duplicate message ids (history + ws replay)
            if (msg.id && prev.some((m) => 'id' in m && m.id === msg.id)) return prev;
            // Dedup the optimistic user echo: handleSend adds a `local-…` user
            // message immediately; the transcript tail then streams the SAME turn
            // back with the real id. Match the pending local echo by text and
            // adopt the real id instead of appending a second bubble.
            if (msg.role === 'user') {
              const echoIdx = prev.findIndex(
                (m) =>
                  'role' in m &&
                  m.role === 'user' &&
                  typeof m.id === 'string' &&
                  m.id.startsWith('local-') &&
                  m.text === msg.text,
              );
              if (echoIdx !== -1) {
                const next = [...prev];
                next[echoIdx] = { ...(next[echoIdx] as ThreadMessage), id: msg.id };
                return next;
              }
            }
            return [...prev, msg];
          });
        } else if (event.type === 'tool') {
          // Conductor tool call → collapsible tool card (SHR-161)
          const card: ToolCallItem = {
            kind: 'tool-call',
            id: event.id,
            toolName: event.tool_name,
            input: event.input,
          };
          setItems((prev) => {
            if (prev.some((i) => 'id' in i && i.id === card.id)) return prev;
            return [...prev, card];
          });
        } else if (event.type === 'card') {
          // Dispatch the right card variant based on command
          if (event.command === 'view-spec') {
            const args = event.args as {
              task_id?: string;
              spec_path?: string;
              artifact_url?: string;
            };
            const card: SpecCardItem = {
              kind: 'spec-card',
              id: event.id,
              taskId: args.task_id ?? '',
              specPath: args.spec_path ?? 'spec.md',
              artifactUrl: args.artifact_url ?? '',
              resolved: false,
            };
            setItems((prev) => {
              if (prev.some((i) => 'id' in i && i.id === card.id)) return prev;
              return [...prev, card];
            });
          } else if (event.command === 'approve-plan') {
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
    } catch (err) {
      toast.error(`Could not create conversation: ${(err as Error).message}`);
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
    } catch (err) {
      toast.error(`Could not toggle global-monitor: ${(err as Error).message}`);
    }
  }, []);

  // ─── Send user turn ──────────────────────────────────────────────────────

  const handleSend = useCallback((text: string) => {
    const sent = wsRef.current?.send({ type: 'user_turn' as const, text }) ?? false;
    if (!sent) {
      // Not silently dropped — surface it and offer a one-click retry (SHR-162).
      toast.error('Not connected — message not sent', {
        description: 'The orchestrator socket is offline. Retry once it reconnects.',
        action: { label: 'Retry', onClick: () => handleSend(text) },
      });
      return;
    }
    // Optimistically add the user message to the thread
    const msg: ThreadMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
    };
    setItems((prev) => [...prev, msg]);
    setWorking(true);
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
      setWorking(true);
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
        if (
          (item.kind === 'plan-card' || item.kind === 'action-card' || item.kind === 'spec-card') &&
          item.id === card_id
        ) {
          return { ...item, resolved: true };
        }
        return item;
      }),
    );
  }, []);

  // ─── Spec card dismiss (local only — no ws event) ────────────────────────

  const handleSpecCardDismiss = useCallback((cardId: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (!('kind' in item)) return item;
        if (item.kind === 'spec-card' && item.id === cardId) {
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
                <ConnectionPill state={wsState} />
                {/* Conductor-leanness indicator (§6.7): surfaces orchestrator activity
                    so the user can see if the conductor is accumulating too much context. */}
                {usage !== null && <LeanessIndicator usage={usage} />}
              </div>

              {/* Mixed thread (messages + plan cards + spec cards) */}
              <MixedThread
                items={items}
                onCardDecision={handleCardDecision}
                onSpecCardDismiss={handleSpecCardDismiss}
                working={working}
              />

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

// ─── ConnectionPill ─────────────────────────────────────────────────────────

/**
 * WebSocket connection-status pill (SHR-162). Surfaces connecting / live /
 * reconnecting so a dropped socket is visible instead of silently dead.
 */
function ConnectionPill({ state }: { state: WsConnectionState }) {
  const config: Record<
    WsConnectionState,
    { label: string; dot: string; pulse: boolean; aria: string }
  > = {
    connecting: { label: 'connecting', dot: 'bg-[#FB923C]', pulse: true, aria: 'Connecting' },
    open: { label: 'live', dot: 'bg-[#22C55E]', pulse: false, aria: 'Connected' },
    reconnecting: { label: 'reconnecting', dot: 'bg-[#FB923C]', pulse: true, aria: 'Reconnecting' },
    closed: { label: 'offline', dot: 'bg-[rgba(255,255,255,0.3)]', pulse: false, aria: 'Offline' },
  };
  const { label, dot, pulse, aria } = config[state];

  return (
    <span
      role="status"
      aria-label={aria}
      title={`WebSocket ${label}`}
      className="ml-2 flex shrink-0 items-center gap-1.5 text-[11px] text-[rgba(255,255,255,0.45)]"
    >
      <span className={cn('h-2 w-2 rounded-full', dot, pulse && 'animate-pulse')} />
      {label}
    </span>
  );
}

// ─── LeanessIndicator ─────────────────────────────────────────────────────────

/**
 * Conductor-leanness indicator (§6.7).
 *
 * Surfaces orchestrator-vs-worker activity so the user can tell if the
 * conductor is accumulating context that should be delegated. Shows:
 *  - tasks spawned
 *  - tool calls made
 *
 * Turns orange/warning when tasks_spawned >= 12 or tool_calls >= 40
 * (spec §10: soft threshold = "12 tasks spawned or M minutes").
 * These are configurable thresholds; off-by-default in the UI
 * (only shown when a conversation is open).
 */
interface LeanessIndicatorProps {
  usage: ConversationUsage;
}

function LeanessIndicator({ usage }: LeanessIndicatorProps) {
  const TASKS_WARN = 12;
  const CALLS_WARN = 40;
  const isWarning = usage.tasks_spawned >= TASKS_WARN || usage.tool_calls >= CALLS_WARN;

  return (
    <div
      aria-label="Conductor leanness stats"
      title={`Conductor activity: ${usage.tasks_spawned} tasks spawned, ${usage.tool_calls} tool calls`}
      className={cn(
        'ml-auto flex items-center gap-2 rounded-md px-2 py-1 text-xs tabular-nums',
        isWarning
          ? 'bg-[rgba(251,146,60,0.12)] text-[#FB923C]'
          : 'bg-[rgba(255,255,255,0.04)] text-[rgba(255,255,255,0.45)]',
      )}
    >
      {isWarning && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M6 1L1 11h10L6 1zm0 2l3.5 7h-7L6 3zm-.5 3v2h1V6h-1zm0 3v1h1V9h-1z" />
        </svg>
      )}
      <span>{usage.tasks_spawned} tasks</span>
      <span aria-hidden="true">·</span>
      <span>{usage.tool_calls} calls</span>
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
