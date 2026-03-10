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

// ─── useTasks ────────────────────────────────────────────────────────────────

describe('useTasks', () => {
  it('starts in loading state', async () => {
    apiMock.listTasks.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTasks(60000));
    expect(result.current.loading).toBe(true);
    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns tasks after fetch', async () => {
    const tasks = [{ id: 't1', title: 'Test' }];
    apiMock.listTasks.mockResolvedValue(tasks);

    const { result } = renderHook(() => useTasks(60000));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.tasks).toEqual(tasks);
    expect(result.current.error).toBeNull();
  });

  it('sets error on fetch failure', async () => {
    apiMock.listTasks.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTasks(60000));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Network error');
    expect(result.current.tasks).toEqual([]);
  });

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

  it('polls at the specified interval', async () => {
    apiMock.listTasks.mockResolvedValue([]);

    // Use a very short interval for testing
    renderHook(() => useTasks(50));

    await waitFor(() => {
      expect(apiMock.listTasks).toHaveBeenCalledTimes(1);
    });

    // Wait for at least one poll cycle
    await waitFor(
      () => {
        expect(apiMock.listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 500 },
    );
  });

  it('cleans up interval on unmount', async () => {
    apiMock.listTasks.mockResolvedValue([]);

    const { unmount } = renderHook(() => useTasks(50));

    await waitFor(() => {
      expect(apiMock.listTasks).toHaveBeenCalledTimes(1);
    });

    unmount();
    const callCount = apiMock.listTasks.mock.calls.length;

    // Wait to confirm no more calls happen
    await new Promise((r) => setTimeout(r, 150));
    expect(apiMock.listTasks.mock.calls.length).toBe(callCount);
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

// ─── useTask ─────────────────────────────────────────────────────────────────

describe('useTask', () => {
  it('returns task after fetch', async () => {
    const task = { id: 't1', title: 'Test' };
    apiMock.getTask.mockResolvedValue(task);

    const { result } = renderHook(() => useTask('t1', 60000));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.task).toEqual(task);
  });

  it('calls getTask with the provided id', async () => {
    apiMock.getTask.mockResolvedValue({ id: 'my-task' });

    renderHook(() => useTask('my-task', 60000));

    await waitFor(() => {
      expect(apiMock.getTask).toHaveBeenCalledWith('my-task');
    });
  });

  it('sets error on fetch failure', async () => {
    apiMock.getTask.mockRejectedValue(new Error('Not found'));

    const { result } = renderHook(() => useTask('t1', 60000));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Not found');
    expect(result.current.task).toBeNull();
  });

  it('polls at the specified interval', async () => {
    apiMock.getTask.mockResolvedValue({ id: 't1' });

    renderHook(() => useTask('t1', 50));

    await waitFor(() => {
      expect(apiMock.getTask).toHaveBeenCalledTimes(1);
    });

    await waitFor(
      () => {
        expect(apiMock.getTask.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 500 },
    );
  });

  it('cleans up interval on unmount', async () => {
    apiMock.getTask.mockResolvedValue({ id: 't1' });

    const { unmount } = renderHook(() => useTask('t1', 50));

    await waitFor(() => {
      expect(apiMock.getTask).toHaveBeenCalledTimes(1);
    });

    unmount();
    const callCount = apiMock.getTask.mock.calls.length;

    await new Promise((r) => setTimeout(r, 150));
    expect(apiMock.getTask.mock.calls.length).toBe(callCount);
  });
});
