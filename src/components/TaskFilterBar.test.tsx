import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskFilterBar } from './TaskFilterBar';
import { renderWithRouter } from '../test-helpers';

const defaultProps = {
  activeStatus: 'open' as const,
  counts: { open: 3, closed: 1, backlog: 2 },
  onStatusChange: () => {},
  repos: ['/path/to/alpha', '/path/to/beta'],
  activeRepo: '',
  onRepoChange: () => {},
  viewMode: 'cards' as const,
  onViewChange: () => {},
};

describe('TaskFilterBar', () => {
  it('renders Open, Backlog, and Closed tabs with counts', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    expect(screen.getByText(/^Open/)).toBeInTheDocument();
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.getByText(/^Backlog/)).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getByText(/^Closed/)).toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    const openBtn = screen.getByText(/^Open/).closest('button')!;
    expect(openBtn.className).toContain('border-b-2');
  });

  it('calls onStatusChange when clicking tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByText(/^Closed/).closest('button')!);
    expect(onChange).toHaveBeenCalledWith('closed');
  });

  it('calls onStatusChange when clicking backlog tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByText(/^Backlog/).closest('button')!);
    expect(onChange).toHaveBeenCalledWith('backlog');
  });

  it('renders repo dropdown when multiple repos exist', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    const trigger = screen.getByText('All projects');
    expect(trigger).toBeInTheDocument();
  });

  it('hides repo dropdown when only one repo exists', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} repos={['/path/to/only-one']} />);
    expect(screen.queryByText('All projects')).not.toBeInTheDocument();
  });

  it('calls onRepoChange when selecting a repo', async () => {
    const user = userEvent.setup();
    const onRepoChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onRepoChange={onRepoChange} />);
    // Open the popover
    await user.click(screen.getByText('All projects'));
    // Click the repo option
    await user.click(screen.getByText('beta'));
    expect(onRepoChange).toHaveBeenCalledWith('/path/to/beta');
  });
});
