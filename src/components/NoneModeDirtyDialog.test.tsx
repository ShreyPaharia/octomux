import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NoneModeDirtyDialog } from './NoneModeDirtyDialog';

describe('NoneModeDirtyDialog', () => {
  it('renders the count and the current branch', () => {
    render(
      <NoneModeDirtyDialog
        open
        count={3}
        currentBranch="main"
        targetBranch="feature-x"
        onClose={vi.fn()}
        onStash={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 uncommitted change/i)).toBeInTheDocument();
    expect(screen.getByText(/main/)).toBeInTheDocument();
  });

  it('calls onStash when stash-and-continue clicked', async () => {
    const onStash = vi.fn().mockResolvedValue(undefined);
    render(
      <NoneModeDirtyDialog
        open
        count={1}
        currentBranch="main"
        targetBranch="feature-x"
        onClose={vi.fn()}
        onStash={onStash}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /stash and continue/i }));
    await waitFor(() => expect(onStash).toHaveBeenCalled());
  });

  it('calls onClose when cancel clicked', () => {
    const onClose = vi.fn();
    render(
      <NoneModeDirtyDialog
        open
        count={1}
        currentBranch="main"
        targetBranch="feature-x"
        onClose={onClose}
        onStash={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
