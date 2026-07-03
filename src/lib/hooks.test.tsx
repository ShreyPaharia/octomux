import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useTasks,
  useTask,
  useGraceHours,
  useProviders,
  useIntegrations,
  useHookTemplates,
  useSettings,
  useReviewDetail,
} from './hooks';

// ─── Mock API ────────────────────────────────────────────────────────────────

const { taskApiProxy, configApiProxy, reviewApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('./api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('./api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('./api/reviewApi', () => ({ reviewApi: reviewApiProxy }));

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
    // useTasks calls listTasks twice per refresh (active + trash)
    callsPerRefresh: 2,
  },
  {
    name: 'useTask',
    renderFn: () => renderHook(() => useTask('t1')),
    mockFn: () => apiMock.getTask,
    successValue: { id: 't1', title: 'Test' },
    resultKey: 'task' as const,
    emptyValue: null,
    callsPerRefresh: 1,
  },
];

describe.each(hookCases)(
  '$name',
  ({ renderFn, mockFn, successValue, resultKey, emptyValue, callsPerRefresh }) => {
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
      expect(mockFn()).toHaveBeenCalledTimes(callsPerRefresh);

      // Simulate a server event
      await act(async () => {
        eventCallback?.({ type: 'task:updated', payload: { taskId: 't1' } });
      });

      expect(mockFn()).toHaveBeenCalledTimes(callsPerRefresh * 2);
    });

    it('unsubscribes on unmount', async () => {
      mockFn().mockResolvedValue(successValue);

      const { unmount } = renderFn();

      await waitFor(() => {
        expect(mockFn()).toHaveBeenCalledTimes(callsPerRefresh);
      });

      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });
  },
);

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

// ─── useResource-based config/review hooks ───────────────────────────────────

const resourceHookCases = [
  {
    name: 'useGraceHours',
    renderFn: () => renderHook(() => useGraceHours()),
    mockFn: () => apiMock.getSettings,
    successValue: { deleteGraceHours: 12 },
    resultKey: 'graceHours' as const,
    expectedValue: 12,
    fallbackValue: 6,
  },
  {
    name: 'useProviders',
    renderFn: () => renderHook(() => useProviders()),
    mockFn: () => apiMock.listProviders,
    successValue: [{ kind: 'jira', displayName: 'Jira', configSchema: {}, events: [] }],
    resultKey: 'providers' as const,
    expectedValue: [{ kind: 'jira', displayName: 'Jira', configSchema: {}, events: [] }],
    fallbackValue: [],
  },
  {
    name: 'useIntegrations',
    renderFn: () => renderHook(() => useIntegrations()),
    mockFn: () => apiMock.listIntegrations,
    successValue: [{ id: 'i1', kind: 'jira', name: 'Jira', config: {}, enabled: true }],
    resultKey: 'integrations' as const,
    expectedValue: [{ id: 'i1', kind: 'jira', name: 'Jira', config: {}, enabled: true }],
    fallbackValue: [],
  },
  {
    name: 'useHookTemplates',
    renderFn: () => renderHook(() => useHookTemplates()),
    mockFn: () => apiMock.listHookTemplates,
    successValue: [{ id: 'jira-status', installed: false }],
    resultKey: 'hookTemplates' as const,
    expectedValue: [{ id: 'jira-status', installed: false }],
    fallbackValue: [],
  },
  {
    name: 'useSettings',
    renderFn: () => renderHook(() => useSettings()),
    mockFn: () => apiMock.getSettings,
    successValue: { defaultTracker: 'linear' },
    resultKey: 'settings' as const,
    expectedValue: { defaultTracker: 'linear' },
    fallbackValue: null,
  },
];

describe.each(resourceHookCases)(
  '$name',
  ({ renderFn, mockFn, successValue, resultKey, expectedValue, fallbackValue }) => {
    it('returns data after fetch', async () => {
      mockFn().mockResolvedValue(successValue);

      const { result } = renderFn();

      await waitFor(() => {
        expect((result.current as any)[resultKey]).toEqual(expectedValue);
      });
    });

    it('falls back safely on fetch failure when applicable', async () => {
      mockFn().mockRejectedValue(new Error('fail'));

      const { result } = renderFn();

      await waitFor(() => {
        expect((result.current as any)[resultKey]).toEqual(fallbackValue);
      });
    });
  },
);

describe('useReviewDetail', () => {
  it('fetches review detail for the given id', async () => {
    const detail = { task: { id: 't1', title: 'Review me' }, comments: [], all_runs: [] };
    apiMock.getReviewDetail.mockResolvedValue(detail);

    const { result } = renderHook(() => useReviewDetail('t1'));

    await waitFor(() => {
      expect(result.current.detail).toEqual(detail);
    });
    expect(apiMock.getReviewDetail).toHaveBeenCalledWith('t1');
  });

  it('does not fetch when id is undefined', async () => {
    renderHook(() => useReviewDetail(undefined));
    await Promise.resolve();
    expect(apiMock.getReviewDetail).not.toHaveBeenCalled();
  });
});
