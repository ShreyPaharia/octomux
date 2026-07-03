import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MixedThread } from './MixedThread';
import type { ThreadItem } from './types';

vi.mock('./MessageThread', () => ({
  MessageThread: ({ messages }: { messages: { text: string }[] }) => (
    <div data-testid="message-thread">{messages.map((m) => m.text).join(',')}</div>
  ),
}));

vi.mock('./ToolCallCard', () => ({
  ToolCallCard: ({ toolName }: { toolName: string }) => (
    <div data-testid="tool-call">{toolName}</div>
  ),
}));

describe('MixedThread', () => {
  const noop = vi.fn();

  it('shows empty state when no items and not working', () => {
    render(
      <MixedThread items={[]} onCardDecision={noop} onSpecCardDismiss={noop} working={false} />,
    );
    expect(screen.getByText('No messages yet. Start a conversation below.')).toBeInTheDocument();
  });

  it('renders message batches via MessageThread', () => {
    const items: ThreadItem[] = [
      { id: '1', role: 'user', text: 'hi' },
      { id: '2', role: 'assistant', text: 'hello' },
    ];
    render(<MixedThread items={items} onCardDecision={noop} onSpecCardDismiss={noop} />);
    expect(screen.getByTestId('message-thread')).toHaveTextContent('hi,hello');
  });

  it('shows working indicator when working', () => {
    render(<MixedThread items={[]} onCardDecision={noop} onSpecCardDismiss={noop} working />);
    expect(screen.getByLabelText('Orchestrator is working')).toBeInTheDocument();
  });
});
