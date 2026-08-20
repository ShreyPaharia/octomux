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
const { usePluginUiContributions, usePluginFacts } = await import('./plugin-ui');

beforeEach(() => {
  vi.clearAllMocks();
  eventCallback = null;
});

describe('usePluginUiContributions', () => {
  it('fetches contributions and filters by slot', async () => {
    requestMock.mockResolvedValue({
      contributions: [
        { pluginId: 'a', slot: 'task.panel', fact: 'x', factType: 'a:x', as: 'stat' },
        { pluginId: 'b', slot: 'task.badge', fact: 'y', factType: 'b:y', as: 'badge' },
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

describe('usePluginFacts', () => {
  const contribution = {
    pluginId: 'coverage-bot',
    slot: 'task.panel' as const,
    fact: 'coverage',
    factType: 'coverage-bot:coverage',
    as: 'stat',
  };

  it('fetches facts scoped to the task and qualified fact type', async () => {
    requestMock.mockResolvedValue({
      facts: [
        {
          seq: 1,
          taskId: 't1',
          type: 'coverage-bot:coverage',
          payload: { pct: 90 },
          createdAt: 'x',
        },
      ],
    });

    const { result } = renderHook(() => usePluginFacts('t1', contribution));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(requestMock).toHaveBeenCalledWith('/tasks/t1/facts?type=coverage-bot%3Acoverage');
    expect(result.current.facts).toHaveLength(1);
  });

  it('refetches when an event carries the same taskId', async () => {
    requestMock.mockResolvedValue({ facts: [] });
    renderHook(() => usePluginFacts('t1', contribution));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'task:updated', payload: { taskId: 't1' } });
    });

    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('ignores events for a different task', async () => {
    requestMock.mockResolvedValue({ facts: [] });
    renderHook(() => usePluginFacts('t1', contribution));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    act(() => {
      eventCallback?.({ type: 'task:updated', payload: { taskId: 'other-task' } });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
