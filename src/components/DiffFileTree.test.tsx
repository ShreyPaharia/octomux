import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiffFileEntry } from '@/lib/api/taskApi';
import { DiffFileTree } from './DiffFileTree';
import {
  ignoredGroupKey,
  diffTreeExpandedKey,
  loadExpandedState,
  saveExpandedState,
  clearDiffTreeExpandedState,
} from '@/lib/diff-tree-storage';

beforeEach(() => {
  localStorage.clear();
});

describe('diff tree expand-state persistence helpers', () => {
  it('namespaces the storage key per task', () => {
    expect(diffTreeExpandedKey('t1')).toBe('octomux:diff-tree-expanded:t1');
  });

  it('loadExpandedState returns an empty object when nothing is stored', () => {
    expect(loadExpandedState('t1')).toEqual({});
  });

  it('loadExpandedState parses a stored boolean map', () => {
    localStorage.setItem(
      diffTreeExpandedKey('t1'),
      JSON.stringify({ src: false, 'src/lib': true }),
    );
    expect(loadExpandedState('t1')).toEqual({ src: false, 'src/lib': true });
  });

  it('loadExpandedState ignores non-boolean entries and malformed JSON', () => {
    localStorage.setItem(diffTreeExpandedKey('t1'), JSON.stringify({ src: 'nope', lib: true }));
    expect(loadExpandedState('t1')).toEqual({ lib: true });

    localStorage.setItem(diffTreeExpandedKey('t2'), 'not json');
    expect(loadExpandedState('t2')).toEqual({});
  });

  it('saveExpandedState round-trips through loadExpandedState', () => {
    saveExpandedState('t1', { src: false });
    expect(localStorage.getItem(diffTreeExpandedKey('t1'))).toBe(JSON.stringify({ src: false }));
    expect(loadExpandedState('t1')).toEqual({ src: false });
  });

  it('clearDiffTreeExpandedState removes the per-task keys', () => {
    saveExpandedState('t1', { src: false });
    localStorage.setItem(ignoredGroupKey('t1'), 'true');
    clearDiffTreeExpandedState('t1');
    expect(localStorage.getItem(diffTreeExpandedKey('t1'))).toBeNull();
    expect(localStorage.getItem(ignoredGroupKey('t1'))).toBeNull();
  });
});

describe('DiffFileTree', () => {
  it('renders no group header when there are no ignored entries', () => {
    const files: DiffFileEntry[] = [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    expect(screen.queryByText(/ignored files/i)).not.toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('renders the real basename for deeply-nested files (e.g. docs/**)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const files: DiffFileEntry[] = [
      { path: 'docs/superpowers/README.md', status: 'A', additions: 12, deletions: 0 },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={onSelect} taskId="t1" />);
    // Leaf node shows the actual filename, not an empty string.
    expect(screen.getByText('README.md')).toBeInTheDocument();
    // Clicking the leaf reports the full path back to the parent.
    await user.click(screen.getByText('README.md'));
    expect(onSelect).toHaveBeenCalledWith('docs/superpowers/README.md');
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

  it('keeps folders expanded by default when no state is persisted', () => {
    const files: DiffFileEntry[] = [
      { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0 },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    expect(screen.getByTestId('diff-group-src')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('restores a collapsed folder from localStorage on mount', () => {
    localStorage.setItem(diffTreeExpandedKey('t1'), JSON.stringify({ src: false }));
    const files: DiffFileEntry[] = [
      { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0 },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);
    expect(screen.getByTestId('diff-group-src')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
  });

  it('persists folder collapse to the per-task key on toggle', async () => {
    const user = userEvent.setup();
    const files: DiffFileEntry[] = [
      { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0 },
    ];
    render(<DiffFileTree files={files} selected={null} onSelect={vi.fn()} taskId="t1" />);

    await user.click(screen.getByTestId('diff-group-src'));

    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
    expect(loadExpandedState('t1')).toEqual({ src: false });
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

describe('DiffFileTree reviewed state', () => {
  const filesWithReview: DiffFileEntry[] = [
    { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0, reviewed: true },
    { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0, reviewed: false },
    { path: 'src/c.ts', status: 'M', additions: 1, deletions: 0, reviewed: false },
  ];

  it('renders a checkbox per file', () => {
    render(
      <DiffFileTree
        files={filesWithReview}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('checkbox is checked for reviewed files', () => {
    render(
      <DiffFileTree
        files={filesWithReview}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it('reviewed rows carry data-reviewed=true', () => {
    render(
      <DiffFileTree
        files={filesWithReview}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    const reviewedRow = screen.getByText('a.ts').closest('[data-reviewed]');
    expect(reviewedRow?.getAttribute('data-reviewed')).toBe('true');
  });

  it('clicking the checkbox calls onToggleReviewed with file path and current state', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <DiffFileTree
        files={filesWithReview}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={onToggle}
      />,
    );
    await user.click(screen.getAllByRole('checkbox')[1]);
    expect(onToggle).toHaveBeenCalledWith('src/b.ts', false);
  });

  it('renders (X/Y) counter on folder rows', () => {
    render(
      <DiffFileTree
        files={filesWithReview}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    expect(screen.getByText(/1\s*\/\s*3/)).toBeInTheDocument();
  });
});

describe('DiffFileTree changed-since-review dot', () => {
  it('shows the dot when changed_since_review is true', () => {
    render(
      <DiffFileTree
        files={[
          {
            path: 'src/x.ts',
            status: 'M',
            additions: 1,
            deletions: 0,
            reviewed: false,
            changed_since_review: true,
            reviewed_at_commit: 'abc1234',
          },
        ]}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    expect(screen.getByLabelText(/changed since review/i)).toBeInTheDocument();
  });

  it('clicking the dot opens a popover with the commit short-hash', async () => {
    const user = userEvent.setup();
    render(
      <DiffFileTree
        files={[
          {
            path: 'src/x.ts',
            status: 'M',
            additions: 1,
            deletions: 0,
            reviewed: false,
            changed_since_review: true,
            reviewed_at_commit: 'abc1234567890',
          },
        ]}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    await user.click(screen.getByLabelText(/changed since review/i));
    expect(screen.getByText(/abc1234/)).toBeInTheDocument();
  });

  it('does not show the dot when changed_since_review is false', () => {
    render(
      <DiffFileTree
        files={[
          {
            path: 'src/x.ts',
            status: 'M',
            additions: 1,
            deletions: 0,
            reviewed: true,
            changed_since_review: false,
          },
        ]}
        selected={null}
        onSelect={() => {}}
        onToggleReviewed={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/changed since review/i)).not.toBeInTheDocument();
  });
});
