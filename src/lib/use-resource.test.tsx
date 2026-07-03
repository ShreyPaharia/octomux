import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ServerEvent } from './event-source';
import { useResource } from './use-resource';

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

describe('useResource', () => {
  it('fetches on mount and exposes data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { result } = renderHook(() => useResource('k', fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ value: 1 });
    expect(result.current.error).toBeNull();
  });

  it('refetches when the key changes', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { result, rerender } = renderHook(({ k }) => useResource(k, fetcher), {
      initialProps: { k: 'a' },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ k: 'b' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('refetches when a matching WS event fires', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useResource('k', fetcher, { events: (e) => e.payload.taskId === 't1' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Non-matching event does not refetch
    fire({ type: 'task:updated', payload: { taskId: 't2' } });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Matching event refetches
    fire({ type: 'task:updated', payload: { taskId: 't1' } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('does not open a subscription when no events predicate is given', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    renderHook(() => useResource('k', fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const { unmount } = renderHook(() => useResource('k', fetcher, { events: () => true }));
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when key is null', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useResource(null, fetcher));
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it('captures the error message on failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResource('k', fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('keeps the same data reference when the payload is unchanged (content dedup)', async () => {
    const fetcher = vi.fn().mockResolvedValue({ a: 1 });
    const { result } = renderHook(() => useResource('k', fetcher, { events: () => true }));
    await waitFor(() => expect(result.current.data).toEqual({ a: 1 }));
    const firstRef = result.current.data;

    fire({ type: 'task:updated', payload: {} });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBe(firstRef); // identical JSON → no new reference
  });
});
