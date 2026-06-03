import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewsPage from './ReviewsPage';
import { renderWithRouter } from '../test-helpers';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({ api: apiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function makeRow(
  overrides: Partial<{
    task_id: string;
    pr_number: number;
    pr_title: string;
    repo_path: string;
    status: string;
    draft_count: number;
    accepted_count: number;
    rejected_count: number;
    stale_count: number;
    author_login: string | null;
    last_activity_at: string;
  }> = {},
) {
  return {
    task_id: 't1',
    pr_number: 1,
    pr_url: 'https://github.com/o/r/pull/1',
    pr_title: 'Add foo',
    pr_head_sha: 'sha1',
    author_login: null,
    repo_path: '/repos/foo',
    status: 'drafts-ready',
    draft_count: 2,
    accepted_count: 1,
    rejected_count: 0,
    stale_count: 0,
    last_activity_at: '2026-05-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('ReviewsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no reviews', async () => {
    apiMock.listReviewsInbox.mockResolvedValue([]);
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText(/no open review requests/i)).toBeTruthy();
  });

  it('renders inbox rows with glass cards grouped by repo', async () => {
    apiMock.listReviewsInbox.mockResolvedValue([
      makeRow({
        task_id: 't1',
        pr_title: 'Add foo',
        status: 'drafts-ready',
        repo_path: '/repos/foo',
      }),
      makeRow({
        task_id: 't2',
        pr_number: 2,
        pr_title: 'Fix bar',
        status: 'reviewing',
        repo_path: '/repos/foo',
      }),
    ]);
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText('Add foo')).toBeTruthy();
    expect(screen.getByText('Fix bar')).toBeTruthy();
    expect(screen.getByText('drafts ready')).toBeTruthy();
    expect(screen.getByText('reviewing')).toBeTruthy();
    expect(screen.getByTestId('review-inbox-row-t1')).toBeTruthy();
  });

  it('groups rows under repo name header', async () => {
    apiMock.listReviewsInbox.mockResolvedValue([
      makeRow({ task_id: 't1', pr_title: 'PR one', repo_path: '/repos/alpha' }),
      makeRow({ task_id: 't2', pr_number: 2, pr_title: 'PR two', repo_path: '/repos/beta' }),
    ]);
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText('PR one')).toBeTruthy();
    expect(screen.getByText('PR two')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('Open review navigates to /reviews/:id', async () => {
    const user = userEvent.setup();
    apiMock.listReviewsInbox.mockResolvedValue([
      makeRow({ task_id: 'task-abc', pr_title: 'Clickable PR' }),
    ]);
    renderWithRouter(<ReviewsPage />);
    const row = await screen.findByText('Clickable PR');
    await user.click(row);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/reviews/task-abc'));
  });

  it('shows stale count when > 0', async () => {
    apiMock.listReviewsInbox.mockResolvedValue([makeRow({ stale_count: 3 })]);
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText(/3 stale/)).toBeTruthy();
  });
});
