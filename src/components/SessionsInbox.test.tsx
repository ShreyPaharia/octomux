import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionsInbox } from './SessionsInbox';
import { _resetInboxStore } from '@/lib/inbox';
import { makeTask } from '../test-helpers';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

const eventCallbacks: Set<(event: any) => void> = new Set();
const unsubscribe = vi.fn();
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    eventCallbacks.add(cb);
    return () => {
      eventCallbacks.delete(cb);
      unsubscribe();
    };
  }),
}));

function fireEvent(event: any): void {
  for (const cb of eventCallbacks) cb(event);
}

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderInbox() {
  return render(
    <MemoryRouter>
      <SessionsInbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInboxStore();
  eventCallbacks.clear();
  mockNavigate.mockReset();
  apiMock.getInbox.mockResolvedValue({ needs_you: [], activity: [] });
});

afterEach(() => {
  _resetInboxStore();
});

describe('SessionsInbox', () => {
  it('renders "caught up" when both sections empty', async () => {
    renderInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('inbox-section-needs_you')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-section-activity')).not.toBeInTheDocument();
  });

  it('renders Needs you and Activity sections with rows', async () => {
    apiMock.getInbox.mockResolvedValue({
      needs_you: [makeTask({ id: 'n1', title: 'Auth Rewrite', status: 'error' })],
      activity: [makeTask({ id: 'a1', title: 'Feature XYZ', status: 'closed' })],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-row-n1')).toBeInTheDocument());
    expect(screen.getByTestId('inbox-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-section-needs_you')).toHaveTextContent(/needs you/i);
    expect(screen.getByTestId('inbox-section-activity')).toHaveTextContent(/activity/i);
    expect(screen.queryByTestId('inbox-empty')).not.toBeInTheDocument();
  });

  it('hides a section when it is empty but shows the other', async () => {
    apiMock.getInbox.mockResolvedValue({
      needs_you: [],
      activity: [makeTask({ id: 'a1', status: 'closed' })],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-section-activity')).toBeInTheDocument());
    expect(screen.queryByTestId('inbox-section-needs_you')).not.toBeInTheDocument();
  });

  it('clicking a row navigates to the task', async () => {
    const user = userEvent.setup();
    apiMock.getInbox.mockResolvedValue({
      needs_you: [makeTask({ id: 'n1' })],
      activity: [],
    });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-row-n1')).toBeInTheDocument());
    await user.click(screen.getByTestId('inbox-row-n1'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/n1');
  });

  it('mark-all-read calls API and refetches', async () => {
    const user = userEvent.setup();
    apiMock.getInbox
      .mockResolvedValueOnce({ needs_you: [makeTask({ id: 'n1' })], activity: [] })
      .mockResolvedValueOnce({ needs_you: [], activity: [] });

    renderInbox();

    await waitFor(() => expect(screen.getByTestId('inbox-mark-all-read')).toBeInTheDocument());
    await user.click(screen.getByTestId('inbox-mark-all-read'));

    expect(apiMock.markAllTasksViewed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeInTheDocument());
  });

  it('refetches when a task:* WebSocket event fires (debounced)', async () => {
    vi.useFakeTimers();
    try {
      apiMock.getInbox.mockResolvedValue({ needs_you: [], activity: [] });
      renderInbox();

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(1));

      // Fire several events rapidly
      act(() => {
        fireEvent({ type: 'task:updated', payload: { taskId: 't1' } });
        fireEvent({ type: 'task:updated', payload: { taskId: 't2' } });
        fireEvent({ type: 'task:created', payload: { taskId: 't3' } });
      });

      // Still only the initial call until the debounce expires
      expect(apiMock.getInbox).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
