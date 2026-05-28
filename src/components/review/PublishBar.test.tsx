import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublishBar } from './PublishBar';

const { mockPublishReview, mockRequestReReview } = await vi.hoisted(async () => ({
  mockPublishReview: vi.fn(),
  mockRequestReReview: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    publishReview: mockPublishReview,
    requestReReview: mockRequestReReview,
  },
}));

// sonner toast mock
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('PublishBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishReview.mockResolvedValue({ publishedReviewId: 'pr1', commentCount: 2 });
    mockRequestReReview.mockResolvedValue({ ok: true });
  });

  it('shows accepted, draft, and stale counts', () => {
    render(
      <PublishBar
        taskId="t1"
        acceptedCount={3}
        draftCount={5}
        staleCount={1}
        isRunning={false}
        onPublished={() => {}}
        onReRun={() => {}}
      />,
    );
    expect(screen.getByText(/3 accepted/)).toBeTruthy();
    expect(screen.getByText(/5 drafts/)).toBeTruthy();
    expect(screen.getByText(/1 stale/)).toBeTruthy();
  });

  it('disables Publish button when accepted count is 0', () => {
    render(
      <PublishBar
        taskId="t1"
        acceptedCount={0}
        draftCount={3}
        staleCount={0}
        isRunning={false}
        onPublished={() => {}}
        onReRun={() => {}}
      />,
    );
    const publishBtn = screen.getByText('Publish review').closest('button');
    expect(publishBtn?.disabled).toBe(true);
  });

  it('calls publishReview with correct verdict on click', async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    render(
      <PublishBar
        taskId="t1"
        acceptedCount={2}
        draftCount={0}
        staleCount={0}
        isRunning={false}
        onPublished={onPublished}
        onReRun={() => {}}
      />,
    );
    await user.click(screen.getByText('Publish review'));
    await waitFor(() => {
      expect(mockPublishReview).toHaveBeenCalledWith('t1', { verdict: 'COMMENT' });
      expect(onPublished).toHaveBeenCalled();
    });
  });

  it('disables Re-run button when isRunning=true', () => {
    render(
      <PublishBar
        taskId="t1"
        acceptedCount={0}
        draftCount={0}
        staleCount={0}
        isRunning={true}
        onPublished={() => {}}
        onReRun={() => {}}
      />,
    );
    const reRunBtn = screen.getByText('Running…').closest('button');
    expect(reRunBtn?.disabled).toBe(true);
  });

  it('calls requestReReview when Re-run clicked', async () => {
    const user = userEvent.setup();
    const onReRun = vi.fn();
    render(
      <PublishBar
        taskId="t1"
        acceptedCount={0}
        draftCount={2}
        staleCount={0}
        isRunning={false}
        onPublished={() => {}}
        onReRun={onReRun}
      />,
    );
    await user.click(screen.getByText('Re-run review'));
    await waitFor(() => {
      expect(mockRequestReReview).toHaveBeenCalledWith('t1');
      expect(onReRun).toHaveBeenCalled();
    });
  });
});
