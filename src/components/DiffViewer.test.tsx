import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { diffExpandedKey, reviewedKey } from '@/lib/diff-state';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

// Monaco's DiffEditor does real DOM work; replace with a stub that exposes
// the original/modified content, options, and a per-mount id so tests can
// verify remounts on key change.
let mountCounter = 0;
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    original,
    modified,
    options,
  }: {
    original: string;
    modified: string;
    options?: unknown;
  }) => {
    const idRef = useRef<number | null>(null);
    if (idRef.current === null) idRef.current = ++mountCounter;
    return (
      <div
        data-testid="monaco-diff"
        data-mount-id={String(idRef.current)}
        data-options={JSON.stringify(options ?? {})}
      >
        <pre data-testid="orig">{original}</pre>
        <pre data-testid="mod">{modified}</pre>
      </div>
    );
  },
}));

import { DiffViewer } from './DiffViewer';

beforeEach(() => {
  // Reset mocks to their test-helpers defaults so cross-test state doesn't leak
  apiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
  apiMock.getTaskDiffFile.mockResolvedValue({
    oldContent: '',
    newContent: '',
    status: 'M',
    tooLarge: false,
    binary: false,
  });
  localStorage.clear();
  mountCounter = 0;
});

describe('DiffViewer', () => {
  it('shows base_sha-unavailable empty state when server returns that error', async () => {
    apiMock.getTaskDiffSummary.mockRejectedValue(new Error('base_sha not available for this task'));
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText(/base_sha not captured/i)).toBeInTheDocument());
    // Error path should NOT render the destructive error style.
    expect(screen.queryByText(/base_sha not available for this task/i)).not.toBeInTheDocument();
  });

  it('shows empty state when no files changed', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no changes/i)).toBeInTheDocument();
    });
  });

  it('renders file tree and loads first file in Monaco', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('monaco-diff')).toBeInTheDocument());
    expect(screen.getByTestId('orig')).toHaveTextContent('old');
    expect(screen.getByTestId('mod')).toHaveTextContent('new');
  });

  it('auto-selects the first non-ignored file, skipping ignored entries', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: '.env', status: 'A', additions: 3, deletions: 0, ignored: true },
        { path: 'src/real.ts', status: 'M', additions: 1, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'real-old',
      newContent: 'real-new',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('real-new'));
    expect(screen.getByTestId('orig')).toHaveTextContent('real-old');
  });

  it('shows "too large" message for oversized files', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'big.bin', status: 'M', additions: 0, deletions: 0 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: '',
      newContent: '',
      status: 'M',
      tooLarge: true,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText(/too large/i)).toBeInTheDocument());
  });

  it('switches file when a tree row is clicked', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile
      .mockResolvedValueOnce({
        oldContent: 'a-old',
        newContent: 'a-new',
        status: 'M',
        tooLarge: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        oldContent: '',
        newContent: 'b-new',
        status: 'A',
        tooLarge: false,
        binary: false,
      });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await screen.findByTestId('diff-file-row-a.ts');
    await user.click(
      screen.getByTestId('diff-file-row-b.ts').querySelector('button') as HTMLElement,
    );
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('b-new'));
  });

  it('falls back to first file when the selected file disappears on poll', async () => {
    // First summary: has a.ts (selected) and b.ts
    apiMock.getTaskDiffSummary
      .mockResolvedValueOnce({
        files: [
          { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
          { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
        ],
      })
      // Second summary (after poll): a.ts is gone, only b.ts remains
      .mockResolvedValueOnce({
        files: [{ path: 'b.ts', status: 'A', additions: 5, deletions: 0 }],
      });

    apiMock.getTaskDiffFile
      .mockResolvedValueOnce({
        oldContent: 'a-old',
        newContent: 'a-new',
        status: 'M',
        tooLarge: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        oldContent: '',
        newContent: 'b-new',
        status: 'A',
        tooLarge: false,
        binary: false,
      });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DiffViewer taskId="t1" isRunning={true} />);
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('a-new'));
    // Advance past one poll interval
    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('b-new'));
    vi.useRealTimers();
  });

  it('remounts MonacoDiff (new mount-id) when the selected file changes', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile
      .mockResolvedValueOnce({
        oldContent: 'a-old',
        newContent: 'a-new',
        status: 'M',
        tooLarge: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        oldContent: '',
        newContent: 'b-new',
        status: 'A',
        tooLarge: false,
        binary: false,
      });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('a-new'));
    const firstId = screen.getByTestId('monaco-diff').getAttribute('data-mount-id');
    expect(firstId).not.toBeNull();

    await user.click(
      screen.getByTestId('diff-file-row-b.ts').querySelector('button') as HTMLElement,
    );
    await waitFor(() => expect(screen.getByTestId('mod')).toHaveTextContent('b-new'));
    const secondId = screen.getByTestId('monaco-diff').getAttribute('data-mount-id');
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
  });

  it('toolbar flips label and persists expandedAll to localStorage', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    const btn = await screen.findByRole('button', { name: 'Expand all' });
    expect(localStorage.getItem(diffExpandedKey('t1', 'src/a.ts'))).toBeNull();

    await user.click(btn);

    await screen.findByRole('button', { name: 'Collapse all' });
    expect(localStorage.getItem(diffExpandedKey('t1', 'src/a.ts'))).toBe('true');

    await waitFor(() => {
      const opts = JSON.parse(
        screen.getByTestId('monaco-diff').getAttribute('data-options') ?? '{}',
      );
      expect(opts.hideUnchangedRegions.enabled).toBe(false);
    });
  });

  // ─── Review flow ──────────────────────────────────────────────────────────

  it('clicking the review checkbox persists to localStorage and updates the progress chip', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/b.ts', status: 'A', additions: 1, deletions: 0 },
      ],
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);

    const progress = await screen.findByTestId('review-progress');
    await screen.findByTestId('monaco-diff');
    expect(progress.textContent).toMatch(/0\s*\/\s*2\s*reviewed/);
    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBeNull();

    await user.click(await screen.findByTestId('review-toggle-src/a.ts'));

    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBe('true');
    await waitFor(() => {
      expect(screen.getByTestId('review-progress').textContent).toMatch(/1\s*\/\s*2\s*reviewed/);
    });
    expect(screen.getByTestId('monaco-diff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show file contents/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hide file contents/i })).not.toBeInTheDocument();

    // Second click toggles off
    await user.click(screen.getByTestId('review-toggle-src/a.ts'));
    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBeNull();
  });

  it('renders the review checkbox in the selected file header only', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/b.ts', status: 'A', additions: 1, deletions: 0 },
      ],
    });

    render(<DiffViewer taskId="t1" isRunning={false} />);

    await screen.findByTestId('review-toggle-src/a.ts');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByTestId('review-toggle-src/b.ts')).not.toBeInTheDocument();
  });

  it('uses API-backed reviewed state for the header checkbox', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0, reviewed: true }],
    });

    render(<DiffViewer taskId="t1" isRunning={false} onToggleReviewed={() => {}} />);

    const checkbox = (await screen.findByTestId('review-toggle-src/a.ts')) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it('reviewed files render dimmed (opacity-50) and the row carries a data-reviewed flag', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }],
    });
    localStorage.setItem(reviewedKey('t1', 'src/a.ts'), 'true');
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => {
      expect(screen.getByTestId('diff-file-row-src/a.ts')).toHaveAttribute('data-reviewed', 'true');
    });
    expect(screen.getByTestId('diff-file-row-src/a.ts').className).toMatch(/opacity-50/);
  });

  it('groups files by top-level directory in the file tree', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'design/page.md', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/components/Foo.tsx', status: 'A', additions: 10, deletions: 0 },
        { path: 'src/components/Bar.tsx', status: 'M', additions: 2, deletions: 1 },
      ],
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => {
      expect(screen.getByTestId('diff-group-design')).toBeInTheDocument();
      expect(screen.getByTestId('diff-group-src')).toBeInTheDocument();
      expect(screen.getByTestId('diff-group-src/components')).toBeInTheDocument();
    });
  });

  // ─── Inline comment composer ────────────────────────────────────────────

  describe('inline comment composer', () => {
    it('clicking a line opens the composer below it', async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(
        <DiffViewer
          oldContent={'a\nb\nc'}
          newContent={'a\nbb\nc'}
          path="src/foo.ts"
          onAddComment={onAddComment}
        />,
      );
      await user.click(screen.getByText('bb'));
      expect(screen.getByPlaceholderText(/leave a comment/i)).toBeInTheDocument();
    });

    it('Enter saves the comment with file path, line, and line text', async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(
        <DiffViewer oldContent="a" newContent="aa" path="src/foo.ts" onAddComment={onAddComment} />,
      );
      await user.click(screen.getByText('aa'));
      const input = screen.getByPlaceholderText(/leave a comment/i);
      await user.type(input, 'rename pls{Enter}');
      expect(onAddComment).toHaveBeenCalledWith({
        filePath: 'src/foo.ts',
        line: 1,
        lineText: 'aa',
        body: 'rename pls',
      });
    });

    it('Esc discards without calling onAddComment', async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(
        <DiffViewer oldContent="a" newContent="aa" path="src/foo.ts" onAddComment={onAddComment} />,
      );
      await user.click(screen.getByText('aa'));
      const input = screen.getByPlaceholderText(/leave a comment/i);
      await user.type(input, 'wip{Escape}');
      expect(onAddComment).not.toHaveBeenCalled();
    });

    it('shows existing queued comments as pills under the line', () => {
      render(
        <DiffViewer
          oldContent="a"
          newContent="aa"
          path="src/foo.ts"
          onAddComment={() => {}}
          queuedComments={[
            { id: '1', filePath: 'src/foo.ts', line: 1, lineText: 'aa', body: 'rename' },
          ]}
        />,
      );
      expect(screen.getByText('rename')).toBeInTheDocument();
    });
  });

  it('reads stored expandedAll on mount and passes hideUnchangedRegions=false', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
    });
    localStorage.setItem(diffExpandedKey('t1', 'src/a.ts'), 'true');

    render(<DiffViewer taskId="t1" isRunning={false} />);

    await screen.findByRole('button', { name: 'Collapse all' });
    const opts = JSON.parse(screen.getByTestId('monaco-diff').getAttribute('data-options') ?? '{}');
    expect(opts.hideUnchangedRegions.enabled).toBe(false);
  });
});
