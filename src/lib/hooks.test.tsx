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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Shared hook behavior (table-driven) ─────────────────────────────────────

const hookCases = [
  {
    name: 'useTasks',
    renderFn: (interval: number) => renderHook(() => useTasks(interval)),
    mockFn: () => apiMock.listTasks,
    successValue: [{ id: 't1', title: 'Test' }],
    resultKey: 'tasks' as const,
    emptyValue: [],
  },
  {
    name: 'useTask',
    renderFn: (interval: number) => renderHook(() => useTask('t1', interval)),
    mockFn: () => apiMock.getTask,
    successValue: { id: 't1', title: 'Test' },
    resultKey: 'task' as const,
    emptyValue: null,
  },
];

describe.each(hookCases)('$name', ({ renderFn, mockFn, successValue, resultKey, emptyValue }) => {
  it('starts in loading state', async () => {
    mockFn().mockReturnValue(new Promise(() => {}));
    const { result } = renderFn(60000);
    expect(result.current.loading).toBe(true);
    expect((result.current as any)[resultKey]).toEqual(emptyValue);
    expect(result.current.error).toBeNull();
  });

  it('returns data after fetch', async () => {
    mockFn().mockResolvedValue(successValue);

    const { result } = renderFn(60000);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect((result.current as any)[resultKey]).toEqual(successValue);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    mockFn().mockRejectedValue(new Error('Network error'));

    const { result } = renderFn(60000);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Network error');
    expect((result.current as any)[resultKey]).toEqual(emptyValue);
  });

  it('polls at the specified interval', async () => {
    mockFn().mockResolvedValue(successValue);

    renderFn(50);

    await waitFor(() => {
      expect(mockFn()).toHaveBeenCalledTimes(1);
    });

    await waitFor(
      () => {
        expect(mockFn().mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 500 },
    );
  });

  it('cleans up interval on unmount', async () => {
    mockFn().mockResolvedValue(successValue);

    const { unmount } = renderFn(50);

    await waitFor(() => {
      expect(mockFn()).toHaveBeenCalledTimes(1);
    });

    unmount();
    const callCount = mockFn().mock.calls.length;

    await new Promise((r) => setTimeout(r, 150));
    expect(mockFn().mock.calls.length).toBe(callCount);
  });
});

// ─── useTasks-specific ──────────────────────────────────────────────────────

describe('useTasks', () => {
  it('clears error on successful refetch via refresh()', async () => {
    apiMock.listTasks.mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useTasks(60000));

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

    const { result } = renderHook(() => useTasks(60000));

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

    renderHook(() => useTask('my-task', 60000));

    await waitFor(() => {
      expect(apiMock.getTask).toHaveBeenCalledWith('my-task');
    });
  });
});
