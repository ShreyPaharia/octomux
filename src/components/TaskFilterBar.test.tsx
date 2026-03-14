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
};

describe('TaskFilterBar', () => {
  it('renders Open, Backlog, and Closed tabs with counts', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    expect(screen.getByText('Open (3)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (2)')).toBeInTheDocument();
    expect(screen.getByText('Closed (1)')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    const openBtn = screen.getByText('Open (3)');
    expect(openBtn.className).toContain('border-b-2');
  });

  it('calls onStatusChange when clicking tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByText('Closed (1)'));
    expect(onChange).toHaveBeenCalledWith('closed');
  });

  it('calls onStatusChange when clicking backlog tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByText('Backlog (2)'));
    expect(onChange).toHaveBeenCalledWith('backlog');
  });

  it('renders repo dropdown when multiple repos exist', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('All projects')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('hides repo dropdown when only one repo exists', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} repos={['/path/to/only-one']} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('calls onRepoChange when selecting a repo', async () => {
    const user = userEvent.setup();
    const onRepoChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onRepoChange={onRepoChange} />);
    await user.selectOptions(screen.getByRole('combobox'), '/path/to/beta');
    expect(onRepoChange).toHaveBeenCalledWith('/path/to/beta');
  });
});
