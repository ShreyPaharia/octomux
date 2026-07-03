import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ServerEvent } from './event-source';
import { useServerEvents } from './use-server-events';

// ─── Mock event-source ──────────────────────────────────────────────────────

let capturedCb: ((event: ServerEvent) => void) | null = null;
const unsubscribe = vi.fn();
const subscribeMock = vi.fn((cb: (event: ServerEvent) => void) => {
  capturedCb = cb;
  return unsubscribe;
});

vi.mock('./event-source', () => ({
  subscribe: (cb: (event: ServerEvent) => void) => subscribeMock(cb),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedCb = null;
});

function fire(event: ServerEvent) {
  act(() => {
    capturedCb?.(event);
  });
}

describe('useServerEvents', () => {
  it('subscribes on mount and invokes onEvent for events', () => {
    const onEvent = vi.fn();
    renderHook(() => useServerEvents(onEvent));

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    fire({ type: 'task:updated', payload: { taskId: 't1' } });
    expect(onEvent).toHaveBeenCalledWith({ type: 'task:updated', payload: { taskId: 't1' } });
  });

  it('only invokes onEvent for events passing the filter', () => {
    const onEvent = vi.fn();
    renderHook(() => useServerEvents(onEvent, (e) => e.payload.taskId === 't1'));

    fire({ type: 'task:updated', payload: { taskId: 't2' } });
    expect(onEvent).not.toHaveBeenCalled();

    fire({ type: 'task:updated', payload: { taskId: 't1' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('uses the latest onEvent/filter without re-subscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useServerEvents(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    expect(subscribeMock).toHaveBeenCalledTimes(1); // no re-subscribe

    fire({ type: 'task:updated', payload: { taskId: 't1' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useServerEvents(vi.fn()));
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe when onEvent is null', () => {
    renderHook(() => useServerEvents(null));
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});
