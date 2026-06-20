/**
 * src/components/orchestrator/ActionCard.test.tsx
 *
 * Tests for ActionCard (Task 3.3 / SHR-132, spec §5, §11):
 *  - Renders the command name and parsed args as editable fields.
 *  - Approve sends { decision:'approve', card_id } via onDecision.
 *  - Edit: user modifies a field value, then approve sends { decision:'edit', args }.
 *  - Reject sends { decision:'reject', card_id } without running the command.
 *  - Respond: user enters free text, sends { decision:'respond', text }.
 *  - "Always allow this" toggle: when checked + approve, sends always_allow:true.
 *  - Destructive commands (always-ask tier) never show "Always allow" toggle.
 *  - Args with no fields still render gracefully (approve-only card).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { ActionCard, type ActionCardDecision, type ActionCardProps } from './ActionCard';
import { renderWithRouter } from '../../test-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PROPS: ActionCardProps = {
  cardId: 'card-111',
  command: 'create-task',
  args: {
    title: 'Add rate-limit middleware',
    repo_path: '/projects/my-app',
    model: 'claude-opus-4-5',
  },
  onDecision: vi.fn(),
};

const DESTRUCTIVE_PROPS: ActionCardProps = {
  cardId: 'card-222',
  command: 'delete-task',
  args: { task_id: 'task-abc' },
  alwaysAsk: true, // destructive tier — no always-allow toggle
  onDecision: vi.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ActionCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders the command name', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);
    expect(screen.getByText('create-task')).toBeInTheDocument();
  });

  it('renders arg keys and values as editable fields', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);
    // Each arg key should appear as a label
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/repo_path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    // Values should be in the inputs
    expect(screen.getByDisplayValue('Add rate-limit middleware')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/projects/my-app')).toBeInTheDocument();
  });

  it('renders Approve, Edit (once editing), Reject, and Respond buttons', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /respond/i })).toBeInTheDocument();
  });

  it('shows the "always allow this" checkbox for non-destructive commands', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);
    expect(screen.getByRole('checkbox', { name: /always allow/i })).toBeInTheDocument();
  });

  it('does NOT show "always allow" for always-ask (destructive) commands', () => {
    renderWithRouter(<ActionCard {...DESTRUCTIVE_PROPS} />);
    expect(screen.queryByRole('checkbox', { name: /always allow/i })).toBeNull();
  });

  // ── Approve ────────────────────────────────────────────────────────────────

  it.each([
    [
      'approve with unmodified args',
      BASE_PROPS.args,
      { decision: 'approve' as const, card_id: BASE_PROPS.cardId, always_allow: false },
    ],
  ])('%s', (_label, _args, expected: ActionCardDecision) => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...BASE_PROPS} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it('approve sends always_allow:true when "always allow" is checked', () => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...BASE_PROPS} onDecision={onDecision} />);

    // Check the always-allow checkbox
    fireEvent.click(screen.getByRole('checkbox', { name: /always allow/i }));

    // Approve
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approve', always_allow: true }),
    );
  });

  // ── Edit ───────────────────────────────────────────────────────────────────

  it('editing a field value and approving sends decision="edit" with updated args', async () => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...BASE_PROPS} onDecision={onDecision} />);

    // Change the title field
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.change(titleInput, { target: { value: 'Rate-limit v2' } });

    // Approve (should become an edit decision since args changed)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    });

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'edit',
        card_id: BASE_PROPS.cardId,
        args: expect.objectContaining({ title: 'Rate-limit v2' }),
      }),
    );
  });

  // ── Reject ─────────────────────────────────────────────────────────────────

  it('reject sends { decision:"reject", card_id } without running the command', () => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...BASE_PROPS} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'reject', card_id: BASE_PROPS.cardId }),
    );
    // No args payload
    const call = (onDecision.mock.calls as ActionCardDecision[][])[0][0];
    expect(call.args).toBeUndefined();
  });

  // ── Respond ────────────────────────────────────────────────────────────────

  it('clicking Respond expands a free-text input', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);

    // No text input initially
    expect(screen.queryByPlaceholderText(/follow-up/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /respond/i }));

    expect(screen.getByPlaceholderText(/follow-up/i)).toBeInTheDocument();
  });

  it('sending a Respond message emits { decision:"respond", text }', async () => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...BASE_PROPS} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: /respond/i }));

    const textarea = screen.getByPlaceholderText(/follow-up/i);
    fireEvent.change(textarea, { target: { value: 'Please use a different model' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
    });

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'respond',
        card_id: BASE_PROPS.cardId,
        text: 'Please use a different model',
      }),
    );
  });

  it('respond send button is disabled when the text is empty', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole('button', { name: /respond/i }));

    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect(sendBtn).toBeDisabled();
  });

  // ── Args-free card ─────────────────────────────────────────────────────────

  it('renders gracefully when args is empty (no fields)', () => {
    renderWithRouter(<ActionCard {...BASE_PROPS} args={{}} onDecision={vi.fn()} />);
    // No arg rows
    expect(screen.queryByRole('textbox')).toBeNull();
    // Still has the action buttons
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  // ── Destructive tier ───────────────────────────────────────────────────────

  it('destructive command renders a warning badge', () => {
    renderWithRouter(<ActionCard {...DESTRUCTIVE_PROPS} />);
    expect(screen.getByText(/destructive/i)).toBeInTheDocument();
  });

  it('destructive approve still calls onDecision with approve', () => {
    const onDecision = vi.fn();
    renderWithRouter(<ActionCard {...DESTRUCTIVE_PROPS} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approve', card_id: DESTRUCTIVE_PROPS.cardId }),
    );
  });
});
