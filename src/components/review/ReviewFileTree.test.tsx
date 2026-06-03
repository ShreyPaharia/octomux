import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ReviewFileTree } from './ReviewFileTree';
import type { Walkthrough } from './walkthrough-types';
import type { InlineCommentDTO } from '@/lib/api';

function comment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c',
    task_id: 't1',
    file_path: 'src/a.ts',
    line: 1,
    side: 'new',
    body: '',
    status: 'draft',
    kind: 'comment',
    severity: 'nit',
    bucket: null,
    existing_code: null,
    suggested_code: null,
    re_flag_of: null,
    auto_resolved_at: null,
    auto_resolved_reason: null,
    github_comment_id: null,
    review_run_id: null,
    ...overrides,
  };
}

const WT: Walkthrough = {
  groups: [
    {
      name: 'Schema',
      summary: 'db migrations',
      files: [
        { path: 'server/db.ts', label: 'core', summary: 'migration' },
        { path: 'server/missing.ts' },
      ],
    },
    {
      name: 'Frontend',
      files: [{ path: 'src/a.ts', label: 'ui' }],
    },
  ],
};

const defaultProps = {
  reviewedFiles: new Set<string>(),
  onToggleReviewed: () => {},
};

describe('ReviewFileTree', () => {
  it('renders one section per walkthrough group, filtering walkthrough-only files', () => {
    render(
      <ReviewFileTree
        files={['server/db.ts', 'src/a.ts']}
        walkthrough={WT}
        comments={[]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );

    expect(screen.getByTestId('review-file-group-Schema')).toBeTruthy();
    expect(screen.getByTestId('review-file-group-Frontend')).toBeTruthy();
    // Walkthrough file not in diff is filtered out
    expect(screen.queryByTestId('review-file-row-server/missing.ts')).toBeNull();
    // No diff-only files, so no Other group
    expect(screen.queryByTestId('review-file-group-Other')).toBeNull();
  });

  it('preserves walkthrough group order and appends Other at the end', () => {
    const { container } = render(
      <ReviewFileTree
        files={['server/db.ts', 'src/a.ts', 'src/extra.ts']}
        walkthrough={WT}
        comments={[]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );

    const sections = container.querySelectorAll('[data-testid^="review-file-group-"]');
    const names = Array.from(sections).map((s) =>
      s.getAttribute('data-testid')!.replace('review-file-group-', ''),
    );
    expect(names).toEqual(['Schema', 'Frontend', 'Other']);
    expect(screen.getByTestId('review-file-row-src/extra.ts')).toBeTruthy();
  });

  it('colors comment-count pill red when any comment is critical or issue', () => {
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[
          comment({ id: 'c1', severity: 'critical' }),
          comment({ id: 'c2', severity: 'nit' }),
        ]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    const pill = screen.getByTestId('comment-count-src/a.ts');
    expect(pill.getAttribute('data-tone')).toBe('serious');
    expect(pill.textContent).toBe('2');
  });

  it('colors comment-count pill muted when only nits/suggestions present', () => {
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[comment({ id: 'c1', severity: 'nit' })]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    const pill = screen.getByTestId('comment-count-src/a.ts');
    expect(pill.getAttribute('data-tone')).toBe('muted');
  });

  it('hides comment-count pill when count is zero', () => {
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    expect(screen.queryByTestId('comment-count-src/a.ts')).toBeNull();
  });

  it('shows stale count separately and excludes stale comments from open count', () => {
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[
          comment({ id: 'c1', status: 'stale' }),
          comment({ id: 'c2', status: 'stale' }),
          comment({ id: 'c3', severity: 'critical' }),
        ]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    const open = screen.getByTestId('comment-count-src/a.ts');
    expect(open.textContent).toBe('1');
    const stale = screen.getByTestId('stale-count-src/a.ts');
    expect(stale.textContent).toContain('2');
  });

  it('treats published, rejected, and auto-resolved comments as non-open', () => {
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[
          comment({ id: 'c1', status: 'published' }),
          comment({ id: 'c2', status: 'rejected' }),
          comment({ id: 'c3', auto_resolved_at: '2026-05-28' }),
        ]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    expect(screen.queryByTestId('comment-count-src/a.ts')).toBeNull();
  });

  it('calls onSelect with the file path when a row is clicked', () => {
    const onSelect = vi.fn();
    render(
      <ReviewFileTree
        files={['src/a.ts']}
        walkthrough={WT}
        comments={[]}
        selectedPath={null}
        onSelect={onSelect}
        {...defaultProps}
      />,
    );
    // The row is a <li>; selection is handled by the inner button wrapping the filename.
    const row = screen.getByTestId('review-file-row-src/a.ts');
    fireEvent.click(row.querySelector('button')!);
    expect(onSelect).toHaveBeenCalledWith('src/a.ts');
  });

  it('renders Other group only when there are diff-only files', () => {
    render(
      <ReviewFileTree
        files={['scripts/x.sh']}
        walkthrough={null}
        comments={[]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    const other = screen.getByTestId('review-file-group-Other');
    expect(within(other).getByTestId('review-file-row-scripts/x.sh')).toBeTruthy();
  });
});

describe('ReviewFileTree group row', () => {
  const walkthrough: Walkthrough = {
    groups: [
      {
        name: 'Admin Pair Configs — FX-correct hedge size USD',
        summary: 'A long summary that should stay on one line',
        files: [{ path: 'a.go' }, { path: 'b.go' }],
      },
    ],
  };

  it('shows file summary as subtitle on the row', () => {
    render(
      <ReviewFileTree
        files={['server/db.ts']}
        walkthrough={WT}
        comments={[]}
        selectedPath={null}
        onSelect={() => {}}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('migration')).toBeTruthy();
  });

  it('renders the group name in a single truncating element', () => {
    render(
      <ReviewFileTree
        files={['a.go', 'b.go']}
        walkthrough={walkthrough}
        comments={[]}
        selectedPath={null}
        reviewedFiles={new Set()}
        onToggleReviewed={() => {}}
        onSelect={() => {}}
      />,
    );
    const nameEl = screen.getByText(/Admin Pair Configs/);
    expect(nameEl.className).toMatch(/truncate/);
  });

  it('fires onToggleReviewed when the checkbox changes', () => {
    const onToggleReviewed = vi.fn();
    render(
      <ReviewFileTree
        files={['a.go']}
        walkthrough={null}
        comments={[]}
        selectedPath={null}
        reviewedFiles={new Set()}
        onToggleReviewed={onToggleReviewed}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('review-toggle-a.go'));
    expect(onToggleReviewed).toHaveBeenCalledWith('a.go', false);
  });

  it('does not trap focus on the tree nav', () => {
    render(
      <ReviewFileTree
        files={['a.go']}
        walkthrough={null}
        comments={[]}
        selectedPath={null}
        reviewedFiles={new Set()}
        onToggleReviewed={() => {}}
        onSelect={() => {}}
      />,
    );
    const nav = screen.getByTestId('review-file-tree');
    expect(nav.hasAttribute('tabIndex')).toBe(false);
  });
});
