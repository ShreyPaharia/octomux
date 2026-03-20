import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTasks, useTask } from './hooks';

// ─── Mock API ────────────────────────────────────────────────────────────────

const apiMock = {
  listTasks: vi.fn(),
  getTask: vi.fn(),
};

vi.mock('./api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

// ─── Mock event-source ──────────────────────────────────────────────────────

let eventCallback: ((event: any) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock('./event-source', () => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    eventCallback = cb;
    return unsubscribe;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  eventCallback = null;
});

// ─── Shared hook behavior (table-driven) ─────────────────────────────────────

const hookCases = [
  {
    name: 'useTasks',
    renderFn: () => renderHook(() => useTasks()),
    mockFn: () => apiMock.listTasks,
    successValue: [{ id: 't1', title: 'Test' }],
    resultKey: 'tasks' as const,
    emptyValue: [],
  },
  {
    name: 'useTask',
    renderFn: () => renderHook(() => useTask('t1')),
    mockFn: () => apiMock.getTask,
    successValue: { id: 't1', title: 'Test' },
    resultKey: 'task' as const,
    emptyValue: null,
  },
];

describe.each(hookCases)('$name', ({ renderFn, mockFn, successValue, resultKey, emptyValue }) => {
  it('starts in loading state', async () => {
    mockFn().mockReturnValue(new Promise(() => {}));
    const { result } = renderFn();
    expect(result.current.loading).toBe(true);
    expect((result.current as any)[resultKey]).toEqual(emptyValue);
    expect(result.current.error).toBeNull();
  });

  it('returns data after fetch', async () => {
    mockFn().mockResolvedValue(successValue);

    const { result } = renderFn();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect((result.current as any)[resultKey]).toEqual(successValue);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    mockFn().mockRejectedValue(new Error('Network error'));

    const { result } = renderFn();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Network error');
    expect((result.current as any)[resultKey]).toEqual(emptyValue);
  });

  it('re-fetches when event-source fires', async () => {
    mockFn().mockResolvedValue(successValue);

    const { result } = renderFn();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(mockFn()).toHaveBeenCalledTimes(1);

    // Simulate a server event
    await act(async () => {
      eventCallback?.({ type: 'task:updated', payload: { taskId: 't1' } });
    });

    expect(mockFn()).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes on unmount', async () => {
    mockFn().mockResolvedValue(successValue);

    const { unmount } = renderFn();

    await waitFor(() => {
      expect(mockFn()).toHaveBeenCalledTimes(1);
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

// ─── useTasks-specific ──────────────────────────────────────────────────────

describe('useTasks', () => {
  it('clears error on successful refetch via refresh()', async () => {
    apiMock.listTasks.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.error).toBe('fail');
    });

    apiMock.listTasks.mockResolvedValue([{ id: 't1' }]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.tasks).toEqual([{ id: 't1' }]);
  });

  it('provides a refresh function', async () => {
    apiMock.listTasks.mockResolvedValue([]);

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiMock.listTasks.mockResolvedValue([{ id: 't2' }]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tasks).toEqual([{ id: 't2' }]);
  });
});

// ─── useTask-specific ───────────────────────────────────────────────────────

describe('useTask', () => {
  it('calls getTask with the provided id', async () => {
    apiMock.getTask.mockResolvedValue({ id: 'my-task' });

    renderHook(() => useTask('my-task'));

    await waitFor(() => {
      expect(apiMock.getTask).toHaveBeenCalledWith('my-task');
    });
  });
});
