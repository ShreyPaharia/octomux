import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CommentsSidePanel } from './CommentsSidePanel';
import { TaskCommentsContext, type TaskCommentsState } from '@/hooks/useTaskComments';
import type { InlineCommentWithOutdated } from '@/lib/api';

function comment(o: Partial<InlineCommentWithOutdated> = {}): InlineCommentWithOutdated {
  return {
    id: 'c1',
    task_id: 't1',
    agent_id: null,
    file_path: 'src/foo.ts',
    line: 10,
    side: 'new',
    original_commit_sha: 'abc1234',
    body: 'looks good',
    created_at: '2026-05-02 00:00:00',
    resolved_at: null,
    outdated: false,
    ...o,
  };
}

function makeContext(initial: InlineCommentWithOutdated[]): TaskCommentsState {
  const byId = new Map(initial.map((c) => [c.id, c]));
  return {
    byId,
    byFile: (p: string) => initial.filter((c) => c.file_path === p),
    byFileLineSide: (p: string, l: number, s: 'old' | 'new') =>
      initial.filter((c) => c.file_path === p && c.line === l && c.side === s),
    outdatedUnavailable: false,
    loading: false,
    error: null,
    openComposer: null,
    setOpenComposer: vi.fn(),
    focusedId: null,
    setFocusedId: vi.fn(),
    refetch: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(true),
    queueDraft: vi.fn(),
  };
}

function renderPanel(opts: {
  comments: InlineCommentWithOutdated[];
  filesInDiff?: Set<string>;
  rangeIsBase?: boolean;
  onJumpTo?: ReturnType<typeof vi.fn>;
}) {
  const ctx = makeContext(opts.comments);
  const onJumpTo = opts.onJumpTo ?? vi.fn();
  render(
    <TaskCommentsContext.Provider value={ctx}>
      <CommentsSidePanel
        agents={[]}
        filesInDiff={opts.filesInDiff ?? new Set(opts.comments.map((c) => c.file_path))}
        rangeIsBase={opts.rangeIsBase ?? true}
        onJumpTo={onJumpTo}
      />
    </TaskCommentsContext.Provider>,
  );
  return { ctx, onJumpTo };
}

describe('CommentsSidePanel', () => {
  it('renders an empty state when there are no comments', () => {
    renderPanel({ comments: [] });
    expect(screen.getByText('No comments')).toBeInTheDocument();
  });

  it('groups comments by file path', () => {
    renderPanel({
      comments: [
        comment({ id: 'c1', file_path: 'a.ts' }),
        comment({ id: 'c2', file_path: 'b.ts' }),
        comment({ id: 'c3', file_path: 'a.ts', line: 12 }),
      ],
    });
    expect(screen.getAllByText('a.ts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('b.ts').length).toBeGreaterThanOrEqual(1);
  });

  it('filter pills filter by unresolved', () => {
    renderPanel({
      comments: [comment({ id: 'c1' }), comment({ id: 'c2', resolved_at: '2026-05-02 00:01:00' })],
    });
    fireEvent.click(screen.getByText('Unresolved'));
    expect(screen.getByTestId('side-panel-comment-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('side-panel-comment-c2')).not.toBeInTheDocument();
  });

  it('filter pills filter by outdated', () => {
    renderPanel({
      comments: [comment({ id: 'c1', outdated: false }), comment({ id: 'c2', outdated: true })],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Outdated' }));
    expect(screen.queryByTestId('side-panel-comment-c1')).not.toBeInTheDocument();
    expect(screen.getByTestId('side-panel-comment-c2')).toBeInTheDocument();
  });

  it('outdated filter excludes nothing on non-base range', () => {
    renderPanel({
      comments: [comment({ id: 'c1', outdated: true })],
      rangeIsBase: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Outdated' }));
    // Outdated chip suppressed in non-base range, so the filter should hide it.
    expect(screen.queryByTestId('side-panel-comment-c1')).not.toBeInTheDocument();
  });

  it('clicking a comment fires onJumpTo with file/line/side/id', () => {
    const { onJumpTo } = renderPanel({
      comments: [comment({ id: 'c1', file_path: 'a.ts', line: 12, side: 'new' })],
    });
    fireEvent.click(screen.getByTestId('side-panel-comment-c1').querySelector('button')!);
    expect(onJumpTo).toHaveBeenCalledWith('a.ts', 12, 'new', 'c1');
  });

  it('marks file as not-in-diff and disables click', () => {
    const onJumpTo = vi.fn();
    renderPanel({
      comments: [comment({ id: 'c1', file_path: 'gone.ts' })],
      filesInDiff: new Set(),
      onJumpTo,
    });
    expect(screen.getByText('Not in diff')).toBeInTheDocument();
    const btn = within(screen.getByTestId('side-panel-comment-c1')).getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onJumpTo).not.toHaveBeenCalled();
  });

  it('renders Resolved chip for resolved comments', () => {
    renderPanel({
      comments: [comment({ id: 'c1', resolved_at: '2026-05-02 00:01:00' })],
    });
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('renders Outdated chip on base range only', () => {
    const { unmount } = render(
      <TaskCommentsContext.Provider value={makeContext([comment({ id: 'c1', outdated: true })])}>
        <CommentsSidePanel
          agents={[]}
          filesInDiff={new Set(['src/foo.ts'])}
          rangeIsBase={false}
          onJumpTo={vi.fn()}
        />
      </TaskCommentsContext.Provider>,
    );
    // Pill button still says "Outdated" but no chip should appear inside the row.
    const row = screen.getByTestId('side-panel-comment-c1');
    expect(within(row).queryByText('Outdated')).not.toBeInTheDocument();
    unmount();

    render(
      <TaskCommentsContext.Provider value={makeContext([comment({ id: 'c1', outdated: true })])}>
        <CommentsSidePanel
          agents={[]}
          filesInDiff={new Set(['src/foo.ts'])}
          rangeIsBase={true}
          onJumpTo={vi.fn()}
        />
      </TaskCommentsContext.Provider>,
    );
    const row2 = screen.getByTestId('side-panel-comment-c1');
    expect(within(row2).getByText('Outdated')).toBeInTheDocument();
  });
});
