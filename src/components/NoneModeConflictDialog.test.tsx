import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NoneModeConflictDialog } from './NoneModeConflictDialog';

const conflicts = [
  { task_id: 't1', title: 'first', status: 'running' as const, branch: 'feature-x' },
  { task_id: 't2', title: 'second', status: 'setting_up' as const, branch: 'feature-x' },
];

describe('NoneModeConflictDialog', () => {
  it('renders one row per conflict', () => {
    render(
      <NoneModeConflictDialog
        open
        conflicts={conflicts}
        targetBranch="feature-x"
        onClose={vi.fn()}
        onResolved={vi.fn()}
        onCloseTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /close/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('calls onCloseTask when close button clicked', async () => {
    const onCloseTask = vi.fn().mockResolvedValue(undefined);
    render(
      <NoneModeConflictDialog
        open
        conflicts={[conflicts[0]]}
        targetBranch="feature-x"
        onClose={vi.fn()}
        onResolved={vi.fn()}
        onCloseTask={onCloseTask}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0]);
    await waitFor(() => expect(onCloseTask).toHaveBeenCalledWith('t1'));
  });

  it('calls onResolved when conflicts becomes empty', async () => {
    const onResolved = vi.fn();
    const { rerender } = render(
      <NoneModeConflictDialog
        open
        conflicts={[conflicts[0]]}
        targetBranch="feature-x"
        onClose={vi.fn()}
        onResolved={onResolved}
        onCloseTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    rerender(
      <NoneModeConflictDialog
        open
        conflicts={[]}
        targetBranch="feature-x"
        onClose={vi.fn()}
        onResolved={onResolved}
        onCloseTask={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });
});
