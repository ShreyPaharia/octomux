import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderWithRouter, makeTask, makeAgent } from '../test-helpers';

// Stub TerminalView — the WebSocket/xterm wiring is tested elsewhere; here we
// just want to count panes by their data-testid wrapper from AgentGridCell.
vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({ taskId, windowIndex }: { taskId?: string; windowIndex?: number }) => (
    <div data-testid={`terminal-stub-${taskId}-${windowIndex}`} />
  ),
}));

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({ api: apiProxy }));

const GridMonitor = (await import('./GridMonitor')).default;
const { gridColumns, flattenRunningAgents } = await import('./GridMonitor');

beforeEach(() => {
  vi.restoreAllMocks();
  apiMock.listTasks.mockReset();
  apiMock.listTasks.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gridColumns', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 3],
    [7, 3],
    [9, 3],
    [10, 4],
    [25, 4],
  ])('gridColumns(%i) === %i', (count, cols) => {
    expect(gridColumns(count)).toBe(cols);
  });
});

describe('flattenRunningAgents', () => {
  it('skips non-running tasks and stopped agents', () => {
    const flat = flattenRunningAgents([
      makeTask({
        id: 't1',
        runtime_state: 'running',
        agents: [
          makeAgent({ id: 'a1', task_id: 't1', window_index: 0, label: 'Agent A' }),
          makeAgent({
            id: 'a2',
            task_id: 't1',
            window_index: 1,
            label: 'Agent B',
            status: 'stopped',
          }),
        ],
      }),
      makeTask({
        id: 't2',
        runtime_state: 'idle',
        agents: [makeAgent({ id: 'a3', task_id: 't2', window_index: 0 })],
      }),
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].taskId).toBe('t1');
    expect(flat[0].agentName).toBe('Agent A');
  });

  it('includes setting_up tasks too', () => {
    const flat = flattenRunningAgents([
      makeTask({
        id: 't1',
        runtime_state: 'setting_up',
        agents: [makeAgent({ id: 'a1', task_id: 't1', window_index: 0 })],
      }),
    ]);
    expect(flat).toHaveLength(1);
  });
});

describe('GridMonitor page', () => {
  it('shows the empty state when no agents are running', async () => {
    apiMock.listTasks.mockResolvedValue([]);
    renderWithRouter(<GridMonitor />);

    await waitFor(() => {
      expect(screen.getByText(/No running agents/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Create a task/i })).toBeInTheDocument();
  });

  it('renders one pane per running agent', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: 't-a',
        title: 'Task A',
        runtime_state: 'running',
        agents: [
          makeAgent({ id: 'a-0', task_id: 't-a', window_index: 0, label: 'A0' }),
          makeAgent({ id: 'a-1', task_id: 't-a', window_index: 1, label: 'A1' }),
        ],
      }),
      makeTask({
        id: 't-b',
        title: 'Task B',
        runtime_state: 'running',
        agents: [makeAgent({ id: 'b-0', task_id: 't-b', window_index: 0, label: 'B0' })],
      }),
    ]);
    renderWithRouter(<GridMonitor />);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^agent-grid-cell-/)).toHaveLength(3);
    });
    expect(screen.getByTestId('agent-grid-cell-t-a-0')).toBeInTheDocument();
    expect(screen.getByTestId('agent-grid-cell-t-a-1')).toBeInTheDocument();
    expect(screen.getByTestId('agent-grid-cell-t-b-0')).toBeInTheDocument();
  });

  it('refreshes the panes when the tasks list changes via polling', async () => {
    apiMock.listTasks
      .mockResolvedValueOnce([
        makeTask({
          id: 't1',
          runtime_state: 'running',
          agents: [makeAgent({ id: 'a1', task_id: 't1', window_index: 0 })],
        }),
      ])
      .mockResolvedValue([
        makeTask({
          id: 't1',
          runtime_state: 'running',
          agents: [
            makeAgent({ id: 'a1', task_id: 't1', window_index: 0 }),
            makeAgent({ id: 'a2', task_id: 't1', window_index: 1, label: 'Agent B' }),
          ],
        }),
      ]);

    vi.useFakeTimers({ shouldAdvanceTime: true });

    renderWithRouter(<GridMonitor />);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^agent-grid-cell-/)).toHaveLength(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId(/^agent-grid-cell-/)).toHaveLength(2);
    });
  });
});
