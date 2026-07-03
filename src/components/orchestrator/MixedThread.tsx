import { useEffect, useRef, type ReactNode } from 'react';
import { MessageThread, type ThreadMessage } from './MessageThread';
import { ToolCallCard } from './ToolCallCard';
import { PlanCard } from './PlanCard';
import { SpecCard } from './SpecCard';
import { ActionCard } from './ActionCard';
import { WorkingIndicator } from './WorkingIndicator';
import type { ActionCardDecision, ThreadItem } from './types';

export interface MixedThreadProps {
  items: ThreadItem[];
  onCardDecision: (d: ActionCardDecision) => void;
  onSpecCardDismiss: (cardId: string) => void;
  /** True while the orchestrator is processing a turn (shows a working indicator). */
  working?: boolean;
}

/**
 * Renders the thread: a mix of chat messages and inline cards.
 * ThreadMessages are delegated to MessageThread; cards are rendered inline.
 */
export function MixedThread({
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
