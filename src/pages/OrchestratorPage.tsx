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

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ThreadMessage } from '../components/orchestrator/MessageThread';
import { ConversationList } from '../components/orchestrator/ConversationList';
import { ChatInput } from '../components/orchestrator/ChatInput';
import { MixedThread } from '../components/orchestrator/MixedThread';
import { ConnectionPill } from '../components/orchestrator/ConnectionPill';
import { LeanessIndicator } from '../components/orchestrator/LeanessIndicator';
import { OrchestratorEmptyState } from '../components/orchestrator/OrchestratorEmptyState';
import {
  ORCHESTRATOR_SIDEBAR_WIDTH,
  type ActionCardDecision,
  type ActionCardItem,
  type PlanCardItem,
  type SpecCardItem,
  type ThreadItem,
  type ToolCallItem,
} from '../components/orchestrator/types';
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

export default function OrchestratorPage() {
  const [conversations, setConversations] = useState<OrchestratorConversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  const [working, setWorking] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);
  const [usage, setUsage] = useState<ConversationUsage | null>(null);

  const wsRef = useRef<{ send: (e: WsOutgoingEvent) => void; close: () => void } | null>(null);

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

  const openConversation = useCallback(async (convId: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setActiveConvId(convId);
    setItems([]);
    setWsState('connecting');
    setWorking(false);
    setUsage(null);

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

    const handle = openOrchestratorWs(convId, {
      onStatusChange: (state) => setWsState(state),
      onReconnect: () => {
        toast.success('Reconnected to orchestrator');
        void replayHistory();
      },
      onMessage: (event: WsIncomingEvent) => {
        setWorking(false);
        if (event.type === 'message') {
          const msg: ThreadMessage = {
            id: event.id ?? `ws-${Date.now()}-${Math.random()}`,
            role: event.role,
            text: event.text,
          };
          setItems((prev) => {
            if (msg.id && prev.some((m) => 'id' in m && m.id === msg.id)) return prev;
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
            const alwaysAsk = (event.args as { always_ask?: boolean }).always_ask === true;
            const card: ActionCardItem = {
              kind: 'action-card',
              id: event.id,
              command: event.command,
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
        } else if (event.type === 'error') {
          const msg: ThreadMessage = {
            id: `error-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            text: `⚠️ ${event.error}`,
          };
          setItems((prev) => [...prev, msg]);
        }
      },
    });

    wsRef.current = handle;
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

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

  const handleToggleMonitor = useCallback(async (convId: string) => {
    try {
      const result = await orchestratorApi.toggleGlobalMonitor(convId);
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id === convId) {
            return { ...c, is_global_monitor: result.is_global_monitor ? 1 : 0 };
          }
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

  const handleSend = useCallback((text: string) => {
    const sent = wsRef.current?.send({ type: 'user_turn' as const, text }) ?? false;
    if (!sent) {
      toast.error('Not connected — message not sent', {
        description: 'The orchestrator socket is offline. Retry once it reconnects.',
        action: { label: 'Retry', onClick: () => handleSend(text) },
      });
      return;
    }
    const msg: ThreadMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
    };
    setItems((prev) => [...prev, msg]);
    setWorking(true);
  }, []);

  const handleCardDecision = useCallback((d: ActionCardDecision) => {
    if (!wsRef.current) return;
    const { card_id, decision, args, text, always_allow } = d;

    if (decision === 'respond' && text) {
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

    const outgoing: WsOutgoingEvent = {
      type: 'card_decision',
      card_id,
      decision,
      ...(args !== undefined ? { args } : {}),
      ...(always_allow !== undefined ? { always_allow } : {}),
    };
    wsRef.current.send(outgoing);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">Orchestrator</h1>

      <div className="flex min-h-0 flex-1">
        <div
          className="border-r border-[rgba(255,255,255,0.08)]"
          style={{ width: ORCHESTRATOR_SIDEBAR_WIDTH, minWidth: ORCHESTRATOR_SIDEBAR_WIDTH }}
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

        <div className="flex min-h-0 flex-1 flex-col">
          {activeConvId ? (
            <>
              <div className="flex items-center border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {conversations.find((c) => c.id === activeConvId)?.title ?? 'Conversation'}
                </h2>
                <ConnectionPill state={wsState} />
                {usage !== null && <LeanessIndicator usage={usage} />}
              </div>

              <MixedThread
                items={items}
                onCardDecision={handleCardDecision}
                onSpecCardDismiss={handleSpecCardDismiss}
                working={working}
              />

              <ChatInput onSubmit={handleSend} />
            </>
          ) : (
            <OrchestratorEmptyState onNew={handleNewConversation} />
          )}
        </div>
      </div>
    </div>
  );
}
