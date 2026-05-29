import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import ReviewDetailPage from './ReviewDetailPage';
import { renderWithRouter } from '../test-helpers';
import type { ReviewDetail, InlineCommentDTO } from '../lib/api';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

const scrollToFileSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ api: apiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ id: 't1' }) };
});
// Stub DiffViewer so the test focuses on host wiring (file-tree + walkthrough +
// scroll-handle invocation). The real component fetches/renders Monaco and
// pulls in a lot of unrelated machinery.
vi.mock('@/components/DiffViewer', async () => {
  const { useEffect } = await import('react');
  return {
    DiffViewer: ({
      listRef,
      onFilesChange,
    }: {
      listRef?: {
        current: {
          scrollToFile: (p: string) => void;
          revealLineInFile: (p: string, l: number, s?: 'old' | 'new') => void;
        } | null;
      };
      onFilesChange?: (paths: string[]) => void;
    }) => {
      useEffect(() => {
        if (listRef) listRef.current = { scrollToFile: scrollToFileSpy, revealLineInFile: vi.fn() };
        onFilesChange?.(['server/db.ts', 'src/extra.ts']);
      }, [listRef, onFilesChange]);
      return <div data-testid="diff-viewer-stub" />;
    },
  };
});

function comment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c',
    task_id: 't1',
    file_path: 'server/db.ts',
    line: 1,
    side: 'new',
    body: '',
    status: 'draft',
    kind: 'comment',
    severity: 'issue',
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

function makeDetail(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    task: {
      id: 't1',
      title: 'Add foo',
      pr_url: 'https://github.com/o/r/pull/1',
      pr_head_sha: 'sha1',
      pr_number: 1,
      repo_path: '/repos/foo',
    },
    latest_run: null,
    all_runs: [],
    comments: [],
    published_history: [],
    ...overrides,
  };
}

const WALKTHROUGH_JSON = JSON.stringify({
  global: {
    type: 'Enhancement',
    risk: 'low',
    summary: 'adds the thing',
    key_review_points: ['watch migration'],
  },
  groups: [
    {
      name: 'Schema',
      summary: 'db tweaks',
      files: [{ path: 'server/db.ts', label: 'core', summary: 'migration' }],
    },
  ],
});

describe('ReviewDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the PR title from review detail', async () => {
    apiMock.getReviewDetail.mockResolvedValue(makeDetail());
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    expect(await screen.findByText('Add foo')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('shows loading state initially', () => {
    apiMock.getReviewDetail.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('shows error when detail fetch fails', async () => {
    apiMock.getReviewDetail.mockRejectedValue(new Error('not found'));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    expect(await screen.findByText(/not found/i)).toBeTruthy();
  });

  it('renders WalkthroughHeader as a one-line peek strip', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({
        latest_run: {
          id: 'r1',
          pr_head_sha: 'sha1',
          walkthrough: WALKTHROUGH_JSON,
          status: 'done',
        },
      }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const strip = await screen.findByTestId('walkthrough-header');
    expect(strip).toBeTruthy();
    // summary first-sentence visible inline
    expect(strip.textContent).toMatch(/adds the thing/i);
    // meta pills rendered inline (risk + key points count)
    expect(strip.textContent).toMatch(/risk: low/);
    expect(strip.textContent).toMatch(/1 key point/);
  });

  it('renders one ReviewFileTree section per walkthrough group', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({
        latest_run: {
          id: 'r1',
          pr_head_sha: 'sha1',
          walkthrough: WALKTHROUGH_JSON,
          status: 'done',
        },
      }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    expect(await screen.findByTestId('review-file-group-Schema')).toBeTruthy();
  });

  it('renders "Other" group for diff files not in the walkthrough', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({
        latest_run: {
          id: 'r1',
          pr_head_sha: 'sha1',
          walkthrough: WALKTHROUGH_JSON,
          status: 'done',
        },
      }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    expect(await screen.findByTestId('review-file-group-Other')).toBeTruthy();
    expect(screen.getByTestId('review-file-row-src/extra.ts')).toBeTruthy();
  });

  it('clicking a file invokes the DiffViewer scroll handle', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({
        latest_run: {
          id: 'r1',
          pr_head_sha: 'sha1',
          walkthrough: WALKTHROUGH_JSON,
          status: 'done',
        },
        comments: [comment()],
      }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const row = await screen.findByTestId('review-file-row-server/db.ts');
    // Row is now a <li>; the inner selection <button> wraps the filename.
    const selectButton = row.querySelector('button');
    if (!selectButton) throw new Error('expected selection button inside file row');
    fireEvent.click(selectButton);
    await waitFor(() => expect(scrollToFileSpy).toHaveBeenCalledWith('server/db.ts'));
  });

  it('does NOT render the legacy filters bar or inline-comment cards', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({ comments: [comment({ body: 'fix this please' })] }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    await screen.findByText('Add foo');
    expect(screen.queryByText(/^Filter:$/)).toBeNull();
    expect(screen.queryByText('fix this please')).toBeNull();
  });
});
