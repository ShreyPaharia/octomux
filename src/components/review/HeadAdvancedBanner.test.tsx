import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeadAdvancedBanner } from './HeadAdvancedBanner';

const { mockRequestReReview } = await vi.hoisted(async () => ({
  mockRequestReReview: vi.fn(),
}));

vi.mock('@/lib/api/reviewApi', () => ({
  reviewApi: { requestReReview: mockRequestReReview },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Capture the subscribe callback so we can fire fake events
let subscribeCb: ((event: unknown) => void) | null = null;

vi.mock('../../lib/event-source', () => ({
  subscribe: vi.fn((cb: (event: unknown) => void) => {
    subscribeCb = cb;
    return () => {
      subscribeCb = null;
    };
  }),
}));

describe('HeadAdvancedBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeCb = null;
    mockRequestReReview.mockResolvedValue({ ok: true });
  });

  it('does not render when no head-advanced event received', () => {
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={() => {}} />);
    expect(screen.queryByText(/PR head advanced/)).toBeNull();
  });

  it('shows banner when review:head-advanced fires for this task', async () => {
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={() => {}} />);
    subscribeCb?.({
      type: 'review:head-advanced',
      payload: { taskId: 't1', newHeadSha: 'newsha123' },
    });
    expect(await screen.findByText(/PR head advanced/)).toBeTruthy();
    expect(screen.getByText(/newsha12/)).toBeTruthy();
  });

  it('does not show banner for a different task', async () => {
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={() => {}} />);
    subscribeCb?.({
      type: 'review:head-advanced',
      payload: { taskId: 't2', newHeadSha: 'newsha123' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/PR head advanced/)).toBeNull();
  });

  it('dismisses when review:drafts-ready fires and calls onRefresh', async () => {
    const onRefresh = vi.fn();
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={onRefresh} />);
    subscribeCb?.({
      type: 'review:head-advanced',
      payload: { taskId: 't1', newHeadSha: 'newsha123' },
    });
    expect(await screen.findByText(/PR head advanced/)).toBeTruthy();

    subscribeCb?.({
      type: 'review:drafts-ready',
      payload: { taskId: 't1', reviewRunId: 'r2' },
    });
    await waitFor(() => {
      expect(screen.queryByText(/PR head advanced/)).toBeNull();
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it('clicking Re-run incremental review calls requestReReview', async () => {
    const user = userEvent.setup();
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={() => {}} />);
    subscribeCb?.({
      type: 'review:head-advanced',
      payload: { taskId: 't1', newHeadSha: 'newsha123' },
    });
    await screen.findByText('Re-run incremental review');
    await user.click(screen.getByText('Re-run incremental review'));
    await waitFor(() => expect(mockRequestReReview).toHaveBeenCalledWith('t1'));
  });

  it('clicking Dismiss hides the banner', async () => {
    const user = userEvent.setup();
    render(<HeadAdvancedBanner taskId="t1" currentSha="sha-old" onRefresh={() => {}} />);
    subscribeCb?.({
      type: 'review:head-advanced',
      payload: { taskId: 't1', newHeadSha: 'newsha123' },
    });
    await screen.findByText('Dismiss');
    await user.click(screen.getByText('Dismiss'));
    await waitFor(() => {
      expect(screen.queryByText(/PR head advanced/)).toBeNull();
    });
  });
});
