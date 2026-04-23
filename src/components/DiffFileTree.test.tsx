import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiffFileEntry } from '@/lib/api';
import { DiffFileTree, ignoredGroupKey } from './DiffFileTree';

beforeEach(() => {
  localStorage.clear();
});

describe('DiffFileTree', () => {
  it('renders no group header when there are no ignored entries', () => {
    const files: DiffFileEntry[] = [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    expect(screen.queryByText(/ignored files/i)).not.toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('renders the ignored group collapsed by default', () => {
    const files: DiffFileEntry[] = [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'debug.log', status: 'A', additions: 3, deletions: 0, ignored: true },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    // The header is shown…
    const header = screen.getByRole('button', { name: /ignored files \(1\)/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // …but the ignored file itself is hidden.
    expect(screen.queryByText('debug.log')).not.toBeInTheDocument();
  });

  it('expands the ignored group on click and persists the state to localStorage', async () => {
    const user = userEvent.setup();
    const files: DiffFileEntry[] = [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'debug.log', status: 'A', additions: 3, deletions: 0, ignored: true },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);

    await user.click(screen.getByRole('button', { name: /ignored files/i }));

    expect(screen.getByText('debug.log')).toBeInTheDocument();
    expect(localStorage.getItem(ignoredGroupKey('t1'))).toBe('true');
  });

  it('restores prior open state from localStorage on mount', () => {
    localStorage.setItem(ignoredGroupKey('t1'), 'true');
    const files: DiffFileEntry[] = [
      { path: 'debug.log', status: 'A', additions: 3, deletions: 0, ignored: true },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    expect(screen.getByText('debug.log')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ignored files/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows a "more hidden" hint when ignoredTruncated is true', () => {
    const files: DiffFileEntry[] = [
      { path: 'debug.log', status: 'A', additions: 3, deletions: 0, ignored: true },
    ];
    render(
      <DiffFileTree
        files={files}
        selected={null}
        onSelect={vi.fn()}
        taskId="t1"
        ignoredTruncated
      />,
    );
    expect(screen.getByText(/more hidden/i)).toBeInTheDocument();
  });

  it('calls onSelect when an ignored file is clicked after expanding', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const files: DiffFileEntry[] = [
      { path: 'debug.log', status: 'A', additions: 1, deletions: 0, ignored: true },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={onSelect} taskId="t1" />);
    await user.click(screen.getByRole('button', { name: /ignored files/i }));
    await user.click(screen.getByText('debug.log'));
    expect(onSelect).toHaveBeenCalledWith('debug.log');
  });
});
