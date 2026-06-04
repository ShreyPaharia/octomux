import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublishBar } from './PublishBar';

const { mockPublishReview, mockRequestReReview, mockDeleteTask } = await vi.hoisted(async () => ({
  mockPublishReview: vi.fn(),
  mockRequestReReview: vi.fn(),
  mockDeleteTask: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    publishReview: mockPublishReview,
    requestReReview: mockRequestReReview,
    deleteTask: mockDeleteTask,
  },
}));

// sonner toast mock
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function defaultProps(overrides: Partial<Parameters<typeof PublishBar>[0]> = {}) {
  return {
    taskId: 't1',
    prTitle: 'Add foo',
    prNumber: 42,
    prUrl: null,
    acceptedCount: 0,
    draftCount: 0,
    staleCount: 0,
    reviewedDone: 0,
    reviewedTotal: 0,
    totalCommentsCount: 0,
    showCommentsPanel: false,
    onToggleCommentsPanel: vi.fn(),
    isRunning: false,
    onPublished: vi.fn(),
    onReRun: vi.fn(),
    ...overrides,
  };
}

describe('PublishBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishReview.mockResolvedValue({ publishedReviewId: 'pr1', commentCount: 2 });
    mockRequestReReview.mockResolvedValue({ ok: true });
  });

  it('shows PR title and number', () => {
    render(<PublishBar {...defaultProps({ prTitle: 'My PR', prNumber: 7 })} />);
    expect(screen.getByText('My PR')).toBeTruthy();
    expect(screen.getByText('#7')).toBeTruthy();
  });

  it('shows GitHub link when prUrl is provided', () => {
    render(<PublishBar {...defaultProps({ prUrl: 'https://github.com/o/r/pull/42' })} />);
    const link = screen.getByText('GitHub');
    expect(link.closest('a')?.href).toBe('https://github.com/o/r/pull/42');
  });

  it('does not show GitHub link when prUrl is null', () => {
    render(<PublishBar {...defaultProps({ prUrl: null })} />);
    expect(screen.queryByText('GitHub')).toBeNull();
  });

  it('shows accepted, draft, and stale counts', () => {
    render(<PublishBar {...defaultProps({ acceptedCount: 3, draftCount: 5, staleCount: 1 })} />);
    expect(screen.getByText(/3 accepted/)).toBeTruthy();
    expect(screen.getByText(/5 drafts/)).toBeTruthy();
    expect(screen.getByText(/1 stale/)).toBeTruthy();
  });

  it('shows reviewed progress when reviewedTotal > 0', () => {
    render(<PublishBar {...defaultProps({ reviewedDone: 2, reviewedTotal: 5 })} />);
    expect(screen.getByTestId('pr-review-progress')).toBeTruthy();
    expect(screen.getByText(/2\/5 files reviewed/)).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('does not show reviewed progress when reviewedTotal is 0', () => {
    render(<PublishBar {...defaultProps({ reviewedDone: 0, reviewedTotal: 0 })} />);
    expect(screen.queryByTestId('pr-review-progress')).toBeNull();
  });

  it('renders Comments toggle button with count', () => {
    render(<PublishBar {...defaultProps({ totalCommentsCount: 4 })} />);
    expect(screen.getByTestId('comments-toggle')).toBeTruthy();
    expect(screen.getByText('Comments (4)')).toBeTruthy();
  });

  it('applies active styling when showCommentsPanel=true', () => {
    render(<PublishBar {...defaultProps({ showCommentsPanel: true })} />);
    const btn = screen.getByTestId('comments-toggle');
    expect(btn.dataset.active).toBe('true');
  });

  it('calls onToggleCommentsPanel when Comments button clicked', async () => {
    const user = userEvent.setup();
    const onToggleCommentsPanel = vi.fn();
    render(<PublishBar {...defaultProps({ onToggleCommentsPanel })} />);
    await user.click(screen.getByTestId('comments-toggle'));
    expect(onToggleCommentsPanel).toHaveBeenCalled();
  });

  it('disables Publish button when accepted count is 0', () => {
    render(<PublishBar {...defaultProps({ acceptedCount: 0, draftCount: 3 })} />);
    const publishBtn = screen.getByText('Publish review').closest('button');
    expect(publishBtn?.disabled).toBe(true);
  });

  it('calls publishReview with correct verdict on click', async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    render(<PublishBar {...defaultProps({ acceptedCount: 2, onPublished })} />);
    await user.click(screen.getByText('Publish review'));
    await waitFor(() => {
      expect(mockPublishReview).toHaveBeenCalledWith('t1', { verdict: 'COMMENT' });
      expect(onPublished).toHaveBeenCalled();
    });
  });

  it('disables Re-run button when isRunning=true', () => {
    render(<PublishBar {...defaultProps({ isRunning: true })} />);
    const reRunBtn = screen.getByText('Running…').closest('button');
    expect(reRunBtn?.disabled).toBe(true);
  });

  it('calls requestReReview when Re-run clicked', async () => {
    const user = userEvent.setup();
    const onReRun = vi.fn();
    render(<PublishBar {...defaultProps({ draftCount: 2, onReRun })} />);
    await user.click(screen.getByText('Re-run review'));
    await waitFor(() => {
      expect(mockRequestReReview).toHaveBeenCalledWith('t1');
      expect(onReRun).toHaveBeenCalled();
    });
  });

  it('deletes review and calls onDeleted after confirmation', async () => {
    const user = userEvent.setup();
    mockDeleteTask.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(<PublishBar {...defaultProps({ onDeleted })} />);
    await user.click(screen.getByTestId('review-delete-btn'));
    await user.click(screen.getByTestId('confirm-delete-review-confirm'));
    await waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('t1');
      expect(onDeleted).toHaveBeenCalled();
    });
  });
});
