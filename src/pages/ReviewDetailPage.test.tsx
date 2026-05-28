import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import ReviewDetailPage from './ReviewDetailPage';
import { renderWithRouter } from '../test-helpers';
import type { ReviewDetail } from '../lib/api';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({ api: apiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ id: 't1' }) };
});

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
});
