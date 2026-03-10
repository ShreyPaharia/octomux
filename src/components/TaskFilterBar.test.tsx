import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskFilterBar } from './TaskFilterBar';
import { renderWithRouter } from '../test-helpers';

describe('TaskFilterBar', () => {
  it('renders Open and Closed tabs with counts', () => {
    renderWithRouter(
      <TaskFilterBar activeStatus="open" counts={{ open: 3, closed: 1 }} onStatusChange={() => {}} />,
    );
    expect(screen.getByText('Open (3)')).toBeInTheDocument();
    expect(screen.getByText('Closed (1)')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    renderWithRouter(
      <TaskFilterBar activeStatus="open" counts={{ open: 2, closed: 0 }} onStatusChange={() => {}} />,
    );
    const openBtn = screen.getByText('Open (2)');
    expect(openBtn.className).toContain('border-b-2');
  });

  it('calls onStatusChange when clicking tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(
      <TaskFilterBar activeStatus="open" counts={{ open: 2, closed: 1 }} onStatusChange={onChange} />,
    );
    await user.click(screen.getByText('Closed (1)'));
    expect(onChange).toHaveBeenCalledWith('closed');
  });
});
