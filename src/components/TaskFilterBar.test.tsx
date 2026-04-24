import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskFilterBar } from './TaskFilterBar';
import { renderWithRouter } from '../test-helpers';

const defaultProps = {
  activeStatus: 'all' as const,
  counts: { all: 6, running: 3, needs_you: 2, closed: 1 },
  onStatusChange: () => {},
  repos: ['/path/to/alpha', '/path/to/beta'],
  activeRepo: '',
  onRepoChange: () => {},
};

describe('TaskFilterBar', () => {
  it('renders All, Running, Needs You, Closed chips with counts', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    expect(screen.getByTestId('filter-chip-all')).toHaveTextContent(/All/);
    expect(screen.getByTestId('filter-chip-all')).toHaveTextContent('(6)');
    expect(screen.getByTestId('filter-chip-running')).toHaveTextContent(/Running/);
    expect(screen.getByTestId('filter-chip-running')).toHaveTextContent('(3)');
    expect(screen.getByTestId('filter-chip-needs_you')).toHaveTextContent(/Needs You/);
    expect(screen.getByTestId('filter-chip-needs_you')).toHaveTextContent('(2)');
    expect(screen.getByTestId('filter-chip-closed')).toHaveTextContent(/Closed/);
    expect(screen.getByTestId('filter-chip-closed')).toHaveTextContent('(1)');
  });

  it('marks active chip with data-active', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    expect(screen.getByTestId('filter-chip-all')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('filter-chip-running')).not.toHaveAttribute('data-active');
  });

  it('calls onStatusChange when clicking Closed chip', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByTestId('filter-chip-closed'));
    expect(onChange).toHaveBeenCalledWith('closed');
  });

  it('calls onStatusChange when clicking Needs You chip', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onStatusChange={onChange} />);
    await user.click(screen.getByTestId('filter-chip-needs_you'));
    expect(onChange).toHaveBeenCalledWith('needs_you');
  });

  it('renders repo dropdown when multiple repos exist', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    expect(screen.getByText('all repos')).toBeInTheDocument();
  });

  it('hides repo dropdown when only one repo exists', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} repos={['/path/to/only-one']} />);
    expect(screen.queryByText('all repos')).not.toBeInTheDocument();
  });

  it('calls onRepoChange when selecting a repo', async () => {
    const user = userEvent.setup();
    const onRepoChange = vi.fn();
    renderWithRouter(<TaskFilterBar {...defaultProps} onRepoChange={onRepoChange} />);
    await user.click(screen.getByText('all repos'));
    await user.click(screen.getByText('beta'));
    expect(onRepoChange).toHaveBeenCalledWith('/path/to/beta');
  });

  it('wraps content in a glass panel', () => {
    renderWithRouter(<TaskFilterBar {...defaultProps} />);
    const bar = screen.getByTestId('task-filter-bar');
    expect(bar).toHaveAttribute('data-glass-level', '1');
  });
});
