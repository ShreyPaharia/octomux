/**
 * src/components/orchestrator/QuestionCard.tsx
 *
 * Question-shaped card for the `ask_owner` capability — the agent is blocked
 * on a free-text ANSWER, not approve/reject of an implied write. Sibling to
 * ActionCard (src/components/orchestrator/ActionCard.tsx), not a variant of
 * it: no arg fields, no "always allow" toggle (always-ask is never
 * promotable — see policy.ts's addRule doc).
 *
 * Submitting an answer sends `{ decision: 'approve', respond_text: <answer> }`
 * over the same card_decision WS message ActionCard uses — reusing the field
 * the server already reads for a free-text payload (gate.ts's executeCard),
 * rather than 'respond', which has unrelated semantics (injecting a new
 * conductor turn).
 */

import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ActionCardDecision } from './ActionCard';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

export interface QuestionCardProps {
  /** The action_cards.id for this card (sent back in the decision). */
  cardId: string;
  /** The question the agent is asking. */
  question: string;
  /** Called when the user answers or rejects. */
  onDecision: (decision: ActionCardDecision) => void;
}

export function QuestionCard({ cardId, question, onDecision }: QuestionCardProps) {
  const [answer, setAnswer] = useState('');

  const handleSubmit = useCallback(() => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    onDecision({ card_id: cardId, decision: 'approve', text: trimmed });
  }, [answer, cardId, onDecision]);

  const handleReject = useCallback(() => {
    onDecision({ card_id: cardId, decision: 'reject' });
  }, [cardId, onDecision]);

  return (
    <div
      className="rounded-xl border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.03)]"
      data-testid="question-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[rgba(255,255,255,0.08)] px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-[rgba(255,255,255,0.35)]">
          Question
        </p>
        <span className="ml-auto rounded bg-[#F59E0B]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#F59E0B]">
          waiting on you
        </span>
      </div>

      {/* Question text */}
      <div className="px-4 py-3">
        <p className="text-sm text-foreground">{question}</p>
      </div>

      {/* Answer */}
      <div className="flex flex-col gap-2 border-t border-[rgba(255,255,255,0.08)] px-4 py-3">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer…"
          rows={3}
          aria-label="Answer"
          className={cn(
            'w-full resize-none rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]',
            'px-3 py-2 text-sm text-foreground placeholder:text-[rgba(255,255,255,0.3)]',
            'focus:outline-none focus:ring-1 focus:ring-[#3B82F6]',
          )}
          style={{ minHeight: 72 }}
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleReject}
            aria-label="Reject this question"
            className={cn(
              'rounded-lg border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-sm',
              'text-[rgba(255,255,255,0.65)] hover:border-[#EF4444]/50 hover:text-[#EF4444]',
              FOCUS_RING,
            )}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!answer.trim()}
            aria-label="Submit answer"
            className={cn(
              'rounded-lg bg-[#3B82F6] px-3 py-1.5 text-sm font-medium text-white',
              'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40',
              FOCUS_RING,
            )}
          >
            Submit answer
          </button>
        </div>
      </div>
    </div>
  );
}
