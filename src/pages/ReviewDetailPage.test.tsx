import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewDetailPage from './ReviewDetailPage';
import { renderWithRouter } from '../test-helpers';
import type { ReviewDetail, InlineCommentDTO } from '@/lib/api/reviewApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

const scrollToFileSpy = vi.hoisted(() => vi.fn());
const revealLineSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ id: 't1' }) };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
        if (listRef) {
          listRef.current = {
            scrollToFile: scrollToFileSpy,
            revealLineInFile: revealLineSpy,
          };
        }
        onFilesChange?.(['server/db.ts', 'src/extra.ts']);
      }, [listRef, onFilesChange]);
      return <div data-testid="diff-viewer-stub" />;
    },
  };
});

function comment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c1',
    task_id: 't1',
    file_path: 'server/db.ts',
    line: 5,
    side: 'new',
    body: 'fix this please',
    status: 'draft',
    kind: 'comment',
    severity: 'issue',
    bucket: 'actionable',
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
  verdict: 'adds the thing; low risk',
  highlights: [{ title: 'watch migration', file: 'server/db.ts', line: 5, side: 'new' }],
  global: {
    type: 'Enhancement',
    risk: 'low',
    summary: 'adds the thing',
  },
  groups: [
    {
      name: 'Schema',
      summary: 'db tweaks',
      files: [{ path: 'server/db.ts', label: 'core', summary: 'migration' }],
    },
  ],
});

function detailWithWalkthrough(extra: Partial<ReviewDetail> = {}): ReviewDetail {
  return makeDetail({
    latest_run: { id: 'r1', pr_head_sha: 'sha1', walkthrough: WALKTHROUGH_JSON, status: 'done' },
    ...extra,
  });
}

describe('ReviewDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.patchComment.mockImplementation(async (_t, _id, patch) => ({
      ...comment(),
      ...patch,
    }));
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

  it('orients first: renders the walkthrough verdict, risk, and highlights', async () => {
    apiMock.getReviewDetail.mockResolvedValue(detailWithWalkthrough());
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const orient = await screen.findByTestId('walkthrough-orient');
    expect(orient).toBeTruthy();
    expect(screen.getByTestId('walkthrough-verdict').textContent).toMatch(/adds the thing/i);
    expect(screen.getByText(/risk: low/)).toBeTruthy();
    expect(screen.getByText('watch migration')).toBeTruthy();
    // The heavy finding queue is not mounted while orienting.
    expect(screen.queryByTestId('finding-queue')).toBeNull();
  });

  it('clicking a highlight enters review, reveals the code, and syncs the spine', async () => {
    apiMock.getReviewDetail.mockResolvedValue(detailWithWalkthrough());
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const hl = await screen.findByTestId('walkthrough-highlight-0');
    fireEvent.click(hl);
    // summary → code linking
    await waitFor(() => expect(revealLineSpy).toHaveBeenCalledWith('server/db.ts', 5, 'new'));
    // now in review mode with the spine docked and "you are here" synced to the group
    expect(await screen.findByTestId('walkthrough-spine')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('spine-group-Schema').getAttribute('data-active')).toBe('true'),
    );
  });

  it('Start review docks the spine and shows the per-file note in one canonical place', async () => {
    apiMock.getReviewDetail.mockResolvedValue(detailWithWalkthrough({ comments: [comment()] }));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    fireEvent.click(await screen.findByTestId('start-review-btn'));
    const item = await screen.findByTestId('finding-queue-item-c1');
    fireEvent.click(item);
    const fileCtx = await screen.findByTestId('review-context-file');
    expect(fileCtx.textContent).toMatch(/migration/);
  });

  it('renders finding queue with draft body and triage actions', async () => {
    apiMock.getReviewDetail.mockResolvedValue(makeDetail({ comments: [comment()] }));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const detail = await screen.findByTestId('finding-queue-detail');
    expect(detail.textContent).toMatch(/fix this please/);
    expect(screen.getByText('Accept')).toBeTruthy();
  });

  it('accepting a finding enables Publish', async () => {
    const user = userEvent.setup();
    apiMock.getReviewDetail
      .mockResolvedValueOnce(makeDetail({ comments: [comment()] }))
      .mockResolvedValue(makeDetail({ comments: [comment({ status: 'accepted' })] }));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    const publishBtn = (await screen.findByText('Publish review')).closest('button')!;
    expect(publishBtn.disabled).toBe(true);
    await user.click(screen.getByText('Accept'));
    await waitFor(() => expect(apiMock.patchComment).toHaveBeenCalled());
    await waitFor(() => expect(publishBtn.disabled).toBe(false));
  });

  it('shows published history in the Discussion tab with a GitHub link', async () => {
    apiMock.getReviewDetail.mockResolvedValue(
      makeDetail({
        published_history: [
          {
            id: 'pr1',
            github_review_url: 'https://github.com/o/r/pull/1#review-1',
            published_at: '2026-01-01',
            verdict: 'COMMENT',
            comment_count: 2,
          },
        ],
      }),
    );
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    fireEvent.click(await screen.findByTestId('review-tab-discussion'));
    const panel = await screen.findByTestId('published-history-panel');
    expect(panel).toBeTruthy();
    expect(screen.getByText('View on GitHub').closest('a')?.href).toContain('review-1');
  });

  it('selecting a finding reveals its line in the diff', async () => {
    apiMock.getReviewDetail.mockResolvedValue(detailWithWalkthrough({ comments: [comment()] }));
    renderWithRouter(<ReviewDetailPage />, { route: '/reviews/t1', path: '/reviews/:id' });
    fireEvent.click(await screen.findByTestId('start-review-btn'));
    const item = await screen.findByTestId('finding-queue-item-c1');
    fireEvent.click(item);
    await waitFor(() => expect(revealLineSpy).toHaveBeenCalledWith('server/db.ts', 5, 'new'));
  });
});
