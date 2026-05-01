import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  // Reset mocks (clears call history AND queued mockResolvedValueOnce) and
  // re-establish defaults so cross-test state doesn't leak.
  apiMock.getTaskDiffSummary.mockReset().mockResolvedValue({ files: [] });
  apiMock.getTaskDiffFile.mockReset().mockResolvedValue({
    oldContent: '',
    newContent: '',
    status: 'M',
    tooLarge: false,
    binary: false,
    isDirectory: false,
  });
  localStorage.clear();
  history.replaceState(null, '', '/');
  mountCounter = 0;
});

function rowFor(path: string): HTMLElement {
  return screen.getByTestId(`diff-row-${path}`);
}

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

  it('lazy-mounts the first visible file in Monaco', async () => {
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

  it('renders multiple files stacked in sidebar order', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
        { path: 'c.ts', status: 'M', additions: 2, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile.mockImplementation((_id: string, p: string) =>
      Promise.resolve({
        oldContent: `${p}-old`,
        newContent: `${p}-new`,
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      }),
    );
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('monaco-diff')).toHaveLength(3);
    });
    const rows = screen.getAllByTestId(/^diff-row-/);
    expect(rows.map((r) => r.getAttribute('data-file-path'))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('does not refetch loaded files on poll when post_blob_sha is unchanged', async () => {
    apiMock.getTaskDiffSummary
      .mockResolvedValueOnce({
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, post_blob_sha: 'sha1' }],
      })
      .mockResolvedValueOnce({
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, post_blob_sha: 'sha1' }],
      });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
      isDirectory: false,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DiffViewer taskId="t1" isRunning={true} />);
    await waitFor(() => expect(apiMock.getTaskDiffFile).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2500);
    // Allow microtasks to settle.
    await Promise.resolve();
    expect(apiMock.getTaskDiffFile).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('refetches a file on poll when its post_blob_sha changes', async () => {
    apiMock.getTaskDiffSummary
      .mockResolvedValueOnce({
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, post_blob_sha: 'sha1' }],
      })
      .mockResolvedValueOnce({
        files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, post_blob_sha: 'sha2' }],
      });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
      status: 'M',
      tooLarge: false,
      binary: false,
      isDirectory: false,
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DiffViewer taskId="t1" isRunning={true} />);
    await waitFor(() => expect(apiMock.getTaskDiffFile).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(apiMock.getTaskDiffFile).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });

  it('auto-mounts non-ignored files; ignored files stay unmounted', async () => {
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
    await waitFor(() => expect(screen.getAllByTestId('monaco-diff')).toHaveLength(1));
    expect(screen.getByTestId('mod')).toHaveTextContent('real-new');
    // The ignored row exists but doesn't fetch a body.
    expect(rowFor('.env')).toBeInTheDocument();
  });

  it('shows "too large" message for oversized files without mounting Monaco', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'big.bin', status: 'M', additions: 0, deletions: 0, tooLarge: true }],
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText(/too large/i)).toBeInTheDocument());
    expect(screen.queryByTestId('monaco-diff')).not.toBeInTheDocument();
  });

  it('shows a non-crashing directory message when the file resolves to a directory', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'docs/superpowers/somedir', status: 'A', additions: 0, deletions: 0 }],
    });
    apiMock.getTaskDiffFile.mockResolvedValue({
      oldContent: '',
      newContent: '',
      status: 'A',
      tooLarge: false,
      binary: false,
      isDirectory: true,
    });
    render(<DiffViewer taskId="t1" isRunning={false} />);
    await waitFor(() => expect(screen.getByText(/resolves to a directory/i)).toBeInTheDocument());
    // Monaco must NOT mount for a directory entry.
    expect(screen.queryByTestId('monaco-diff')).not.toBeInTheDocument();
  });

  it('clicking a sidebar tree row scrolls to that file and updates the URL hash', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile.mockImplementation((_id: string, p: string) =>
      Promise.resolve({
        oldContent: `${p}-old`,
        newContent: `${p}-new`,
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      }),
    );
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    render(<DiffViewer taskId="t1" isRunning={false} />);
    await screen.findByTestId('diff-file-row-a.ts');
    await user.click(
      screen.getByTestId('diff-file-row-b.ts').querySelector('button') as HTMLElement,
    );

    expect(scrollSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#file=b.ts');
  });

  it('per-row toolbar flips Expand/Collapse label and persists per-file', async () => {
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
    const btn = await screen.findByRole('button', { name: /Expand all in src\/a\.ts/i });
    expect(localStorage.getItem(diffExpandedKey('t1', 'src/a.ts'))).toBeNull();

    await user.click(btn);

    await screen.findByRole('button', { name: /Collapse all in src\/a\.ts/i });
    expect(localStorage.getItem(diffExpandedKey('t1', 'src/a.ts'))).toBe('true');

    await waitFor(() => {
      const opts = JSON.parse(
        screen.getByTestId('monaco-diff').getAttribute('data-options') ?? '{}',
      );
      expect(opts.hideUnchangedRegions.enabled).toBe(false);
    });
  });

  // ─── Review flow ──────────────────────────────────────────────────────────

  it('clicking the per-row review checkbox persists to localStorage and updates the progress chip', async () => {
    const user = userEvent.setup();
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/b.ts', status: 'A', additions: 1, deletions: 0 },
      ],
    });
    apiMock.getTaskDiffFile.mockImplementation((_id: string, p: string) =>
      Promise.resolve({
        oldContent: `${p}-old`,
        newContent: `${p}-new`,
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      }),
    );
    render(<DiffViewer taskId="t1" isRunning={false} />);

    const progress = await screen.findByTestId('review-progress');
    expect(progress.textContent).toMatch(/0\s*\/\s*2\s*reviewed/);
    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBeNull();

    const checkbox = within(rowFor('src/a.ts')).getByTestId('review-toggle-src/a.ts');
    await user.click(checkbox);

    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBe('true');
    await waitFor(() => {
      expect(screen.getByTestId('review-progress').textContent).toMatch(/1\s*\/\s*2\s*reviewed/);
    });

    // Second click toggles off
    await user.click(within(rowFor('src/a.ts')).getByTestId('review-toggle-src/a.ts'));
    expect(localStorage.getItem(reviewedKey('t1', 'src/a.ts'))).toBeNull();
  });

  it('renders a review checkbox per row in the stacked file list', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/b.ts', status: 'A', additions: 1, deletions: 0 },
      ],
    });

    render(<DiffViewer taskId="t1" isRunning={false} />);

    await screen.findByTestId('diff-row-src/a.ts');
    expect(within(rowFor('src/a.ts')).getByTestId('review-toggle-src/a.ts')).toBeInTheDocument();
    expect(within(rowFor('src/b.ts')).getByTestId('review-toggle-src/b.ts')).toBeInTheDocument();
  });

  it('uses API-backed reviewed state for the per-row checkbox', async () => {
    apiMock.getTaskDiffSummary.mockResolvedValue({
      files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0, reviewed: true }],
    });

    render(<DiffViewer taskId="t1" isRunning={false} onToggleReviewed={() => {}} />);

    const checkbox = (await within(await screen.findByTestId('diff-row-src/a.ts')).findByTestId(
      'review-toggle-src/a.ts',
    )) as HTMLInputElement;
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

    await screen.findByRole('button', { name: /Collapse all in src\/a\.ts/i });
    const opts = JSON.parse(screen.getByTestId('monaco-diff').getAttribute('data-options') ?? '{}');
    expect(opts.hideUnchangedRegions.enabled).toBe(false);
  });
});
