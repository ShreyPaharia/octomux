import { describe, it, expect, vi, beforeEach } from '../bun-test.js';

const requestMock = vi.fn();
vi.mock('./api/client', () => ({ request: requestMock }));

let eventCallback: ((event: any) => void) | null = null;
const unsubscribe = vi.fn();
vi.mock('./event-source', () => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    eventCallback = cb;
    return unsubscribe;
  }),
}));

const { renderHook, waitFor, act } = await import('@testing-library/react');
const { usePluginUiContributions, usePluginRecords, usePluginUiActions, invokePluginAction } =
  await import('./plugin-ui');

beforeEach(() => {
  vi.clearAllMocks();
  eventCallback = null;
});

describe('usePluginUiContributions', () => {
  it('fetches contributions and filters by slot', async () => {
    requestMock.mockResolvedValue({
      contributions: [
        { pluginId: 'a', slot: 'task.panel', record: 'x', recordStore: 'a:x', as: 'stat' },
        { pluginId: 'b', slot: 'task.badge', record: 'y', recordStore: 'b:y', as: 'badge' },
      ],
    });

    const { result } = renderHook(() => usePluginUiContributions('task.panel'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestMock).toHaveBeenCalledWith('/plugin-ui/contributions');
    expect(result.current.contributions).toHaveLength(1);
    expect(result.current.contributions[0].pluginId).toBe('a');
  });

  it('refetches when a plugin:ui-updated event arrives', async () => {
    requestMock.mockResolvedValue({ contributions: [] });
    renderHook(() => usePluginUiContributions('task.panel'));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'plugin:ui-updated', payload: {} });
    });

    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('does not refetch on an unrelated event', async () => {
    requestMock.mockResolvedValue({ contributions: [] });
    renderHook(() => usePluginUiContributions('task.panel'));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'chat:updated', payload: { chatId: 'c1' } });
    });

    // Give any (incorrect) refetch a chance to fire, then assert it didn't.
    await new Promise((r) => setTimeout(r, 50));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('usePluginRecords', () => {
  const contribution = {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    record: 'coverage',
    recordStore: 'coverage-bot:coverage',
    as: 'stat',
  };

  it('with a taskId, fetches task-scoped records for the qualified store', async () => {
    requestMock.mockResolvedValue({
      records: [
        {
          seq: 1,
          store: 'coverage-bot:coverage',
          taskId: 't1',
          key: null,
          payload: { pct: 90 },
          createdAt: 'x',
          updatedAt: 'x',
        },
      ],
    });

    const { result } = renderHook(() => usePluginRecords(contribution, 't1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(requestMock).toHaveBeenCalledWith('/tasks/t1/records?store=coverage-bot%3Acoverage');
    expect(result.current.records).toHaveLength(1);
  });

  it('refetches when an event carries the same taskId', async () => {
    requestMock.mockResolvedValue({ records: [] });
    renderHook(() => usePluginRecords(contribution, 't1'));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'task:updated', payload: { taskId: 't1' } });
    });

    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('ignores events for a different task', async () => {
    requestMock.mockResolvedValue({ records: [] });
    renderHook(() => usePluginRecords(contribution, 't1'));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'task:updated', payload: { taskId: 'other-task' } });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('with no taskId, queries the unscoped store endpoint, URL-encoding the ":"', async () => {
    requestMock.mockResolvedValue({
      records: [
        {
          seq: 1,
          store: 'coverage-bot:coverage',
          taskId: null,
          key: 'main',
          payload: { pct: 90 },
          createdAt: 'c',
          updatedAt: 'u',
        },
      ],
    });

    const { result } = renderHook(() => usePluginRecords(contribution));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(requestMock).toHaveBeenCalledWith('/plugin-records/coverage-bot%3Acoverage');
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0].key).toBe('main');
  });

  it('with no taskId, does not refetch on a WS event — no broadcast exists yet for store writes', async () => {
    requestMock.mockResolvedValue({ records: [] });
    renderHook(() => usePluginRecords(contribution));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'plugin:ui-updated', payload: {} });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('usePluginUiActions', () => {
  const actions = [
    { pluginId: 'a', actionId: 'a:restart', id: 'restart', label: 'Restart', slot: 'task.panel' },
    { pluginId: 'b', actionId: 'b:sweep', id: 'sweep', label: 'Sweep', slot: 'board.card' },
    { pluginId: 'c', actionId: 'c:report', id: 'report', label: 'Report', command: true },
  ];

  it('fetches actions and filters by slot when given one', async () => {
    requestMock.mockResolvedValue({ actions });

    const { result } = renderHook(() => usePluginUiActions('task.panel'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(requestMock).toHaveBeenCalledWith('/plugin-ui/actions');
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.actions[0].actionId).toBe('a:restart');
  });

  it('returns every action when called with no slot', async () => {
    requestMock.mockResolvedValue({ actions });

    const { result } = renderHook(() => usePluginUiActions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.actions).toHaveLength(3);
  });

  it('refetches when a plugin:ui-updated event arrives', async () => {
    requestMock.mockResolvedValue({ actions: [] });
    renderHook(() => usePluginUiActions());
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'plugin:ui-updated', payload: {} });
    });

    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('invokePluginAction', () => {
  it('POSTs to the qualified action endpoint with the body, URL-encoding the ":"', async () => {
    requestMock.mockResolvedValue({ ok: true, message: 'done' });

    const result = await invokePluginAction('a:restart', {
      taskId: 't1',
      input: { force: true },
    });

    expect(requestMock).toHaveBeenCalledWith('/plugin-ui/actions/a%3Arestart', {
      method: 'POST',
      body: JSON.stringify({ taskId: 't1', input: { force: true } }),
    });
    expect(result).toEqual({ ok: true, message: 'done' });
  });
});
