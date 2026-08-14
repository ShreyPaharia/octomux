/**
 * src/components/orchestrator/QuestionCard.test.tsx
 *
 * Tests for QuestionCard — the `ask_owner` question-shaped card:
 *  - Renders the question text.
 *  - Submitting an answer sends { decision:'approve', text: <answer> }
 *    (forwarded by OrchestratorPage as respond_text — see its handleCardDecision).
 *  - Submit is disabled until an answer is typed.
 *  - Reject sends { decision:'reject', card_id } without an answer.
 *  - No arg fields, no "always allow" toggle — unlike ActionCard, a question
 *    has no args to edit and always-ask is never promotable.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { QuestionCard, type QuestionCardProps } from './QuestionCard';
import { renderWithRouter } from '../../test-helpers';

const BASE_PROPS: QuestionCardProps = {
  cardId: 'card-q-1',
  question: 'Which base branch should this target?',
  onDecision: vi.fn(),
};

describe('QuestionCard', () => {
  it('renders the question text', () => {
    renderWithRouter(<QuestionCard {...BASE_PROPS} />);
    expect(screen.getByText(BASE_PROPS.question)).toBeInTheDocument();
  });

  it('does not render any arg fields or an "always allow" toggle', () => {
    renderWithRouter(<QuestionCard {...BASE_PROPS} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('disables "Submit answer" until text is typed', () => {
    renderWithRouter(<QuestionCard {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: /submit answer/i })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: /answer/i }), {
      target: { value: 'main' },
    });
    expect(screen.getByRole('button', { name: /submit answer/i })).not.toBeDisabled();
  });

  it('submitting an answer sends decision:approve with the answer text', () => {
    const onDecision = vi.fn();
    renderWithRouter(<QuestionCard {...BASE_PROPS} onDecision={onDecision} />);

    fireEvent.change(screen.getByRole('textbox', { name: /answer/i }), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    expect(onDecision).toHaveBeenCalledWith({
      card_id: BASE_PROPS.cardId,
      decision: 'approve',
      text: 'main',
    });
  });

  it('trims whitespace-only answers and keeps Submit disabled', () => {
    renderWithRouter(<QuestionCard {...BASE_PROPS} />);
    fireEvent.change(screen.getByRole('textbox', { name: /answer/i }), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: /submit answer/i })).toBeDisabled();
  });

  it('Reject sends decision:reject without an answer', () => {
    const onDecision = vi.fn();
    renderWithRouter(<QuestionCard {...BASE_PROPS} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(onDecision).toHaveBeenCalledWith({ card_id: BASE_PROPS.cardId, decision: 'reject' });
  });
});
