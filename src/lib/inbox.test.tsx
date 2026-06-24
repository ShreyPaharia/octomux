import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, render } from '@testing-library/react';
import { useInbox, _resetInboxStore } from './inbox';
import { TasksProvider } from './tasks-context';
import { makeTask } from '../test-helpers';

const { taskApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('./api/taskApi', () => ({ taskApi: taskApiProxy }));

const eventCallbacks: Set<(event: any) => void> = new Set();
const unsubscribe = vi.fn();
vi.mock('./event-source', () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  _resetInboxStore();
  eventCallbacks.clear();
  apiMock.getInbox.mockResolvedValue({ needs_you: [], activity: [] });
});

afterEach(() => {
  _resetInboxStore();
});

describe('useInbox', () => {
  it('fetches inbox on mount', async () => {
    apiMock.getInbox.mockResolvedValue({
      needs_you: [makeTask({ id: 'n1' })],
      activity: [],
    });

    const { result } = renderHook(() => useInbox());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsYou).toHaveLength(1);
    expect(result.current.needsYou[0].id).toBe('n1');
  });

  it('sets error on fetch failure', async () => {
    apiMock.getInbox.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
  });

  it('debounces rapid WebSocket events into a single refetch', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useInbox());

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(1));

      act(() => {
        fireEvent({ type: 'task:updated', payload: { taskId: 't1' } });
        fireEvent({ type: 'task:updated', payload: { taskId: 't2' } });
        fireEvent({ type: 'task:deleted', payload: { taskId: 't3' } });
      });

      expect(apiMock.getInbox).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      await vi.waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('markAllRead hits the API and triggers a refetch', async () => {
    const { result } = renderHook(() => useInbox());
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiMock.getInbox.mockClear();

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(apiMock.markAllTasksViewed).toHaveBeenCalledTimes(1);
    expect(apiMock.getInbox).toHaveBeenCalledTimes(1);
  });

  it('does not re-render unrelated TasksProvider consumers on inbox updates', async () => {
    // An unrelated component that reads TasksProvider state.
    let unrelatedRenderCount = 0;
    function Unrelated() {
      unrelatedRenderCount++;
      return <div data-testid="unrelated">unrelated</div>;
    }

    let inboxRenderCount = 0;
    function InboxConsumer() {
      useInbox();
      inboxRenderCount++;
      return <div data-testid="inbox-consumer">inbox</div>;
    }

    apiMock.getInbox.mockResolvedValue({
      needs_you: [makeTask({ id: 'n1' })],
      activity: [],
    });

    render(
      <TasksProvider>
        <Unrelated />
        <InboxConsumer />
      </TasksProvider>,
    );

    // Wait until the initial inbox fetch has settled and rendered
    await waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(inboxRenderCount).toBeGreaterThanOrEqual(2));

    const unrelatedBaseline = unrelatedRenderCount;
    const inboxBaseline = inboxRenderCount;

    expect(eventCallbacks.size).toBeGreaterThan(0);

    // Queue up a new payload for the next fetch
    apiMock.getInbox.mockResolvedValueOnce({
      needs_you: [makeTask({ id: 'n2' })],
      activity: [],
    });

    // Fire a WS event → debounced refetch
    act(() => {
      fireEvent({ type: 'task:updated', payload: { taskId: 'x' } });
    });

    await waitFor(() => expect(apiMock.getInbox).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(inboxRenderCount).toBeGreaterThan(inboxBaseline));

    // The unrelated consumer must NOT have re-rendered due to the inbox change.
    expect(unrelatedRenderCount).toBe(unrelatedBaseline);
  });
});
