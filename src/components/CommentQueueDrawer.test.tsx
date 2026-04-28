import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentQueueDrawer } from './CommentQueueDrawer.js';

describe('CommentQueueDrawer', () => {
  const comments = [
    { id: '1', filePath: 'src/a.ts', line: 10, lineText: '> if (x)', body: 'dead branch' },
    { id: '2', filePath: 'src/b.ts', line: 5, lineText: '> y', body: 'rename' },
  ];

  it('renders one entry per queued comment', () => {
    render(
      <CommentQueueDrawer
        comments={comments}
        onRemove={() => {}}
        onJumpTo={() => {}}
        onSend={() => {}}
      />,
    );
    expect(screen.getByText('dead branch')).toBeInTheDocument();
    expect(screen.getByText('rename')).toBeInTheDocument();
  });

  it('shows the count in the heading', () => {
    render(
      <CommentQueueDrawer
        comments={comments}
        onRemove={() => {}}
        onJumpTo={() => {}}
        onSend={() => {}}
      />,
    );
    expect(screen.getByText(/Queued review \(2\)/)).toBeInTheDocument();
  });

  it('clicking the x button removes the entry', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <CommentQueueDrawer
        comments={comments}
        onRemove={onRemove}
        onJumpTo={() => {}}
        onSend={() => {}}
      />,
    );
    await user.click(screen.getAllByLabelText(/remove comment/i)[0]);
    expect(onRemove).toHaveBeenCalledWith('1');
  });

  it('clicking an entry calls onJumpTo with file path and line', async () => {
    const onJumpTo = vi.fn();
    const user = userEvent.setup();
    render(
      <CommentQueueDrawer
        comments={comments}
        onRemove={() => {}}
        onJumpTo={onJumpTo}
        onSend={() => {}}
      />,
    );
    await user.click(screen.getByText('dead branch'));
    expect(onJumpTo).toHaveBeenCalledWith('src/a.ts', 10);
  });

  it('Send button label includes count, calls onSend', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <CommentQueueDrawer
        comments={comments}
        onRemove={() => {}}
        onJumpTo={() => {}}
        onSend={onSend}
      />,
    );
    const btn = screen.getByRole('button', { name: /send 2 comments to agent/i });
    await user.click(btn);
    expect(onSend).toHaveBeenCalled();
  });

  it('Send button is disabled when queue is empty', () => {
    render(
      <CommentQueueDrawer
        comments={[]}
        onRemove={() => {}}
        onJumpTo={() => {}}
        onSend={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /send/i });
    expect(btn).toBeDisabled();
  });
});
