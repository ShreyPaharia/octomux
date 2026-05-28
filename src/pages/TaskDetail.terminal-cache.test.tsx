// Regression coverage for the LRU-cache blank-terminal bug introduced in
// cda6a35: switching B→A where A's saved activeWindow equals the outgoing
// task's activeWindow caused setActiveWindow to bail (same value), so the
// LRU-promotion effect never ran to refill the LRU that the task-switch
// effect had just cleared — leaving the terminal pane empty until reload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import TaskDetail, { _resetPerTaskUiState } from './TaskDetail';
import { makeTask, makeAgent } from '../test-helpers';

let eventCallbacks: Set<(event: unknown) => void>;
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn((cb: (event: unknown) => void) => {
    eventCallbacks.add(cb);
    return () => eventCallbacks.delete(cb);
  }),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>;
  return { ...actual, api: apiProxy };
});

// Render the real TerminalView as a thin stub so we can read its props off the DOM.
vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({
    taskId,
    windowIndex,
    visible,
  }: {
    taskId: string;
    windowIndex: number;
    visible?: boolean;
  }) => (
    <div
      data-testid="terminal-view"
      data-task-id={taskId}
      data-window-index={windowIndex}
      data-visible={String(visible ?? true)}
    />
  ),
}));

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: () => <div data-testid="monaco-diff" />,
}));

const taskA = makeTask({
  id: 'task-A',
  title: 'Task A',
  tmux_session: 'octomux-agent-task-A',
  agents: [makeAgent({ id: 'a-A', task_id: 'task-A', window_index: 0 })],
});
const taskB = makeTask({
  id: 'task-B',
  title: 'Task B',
  tmux_session: 'octomux-agent-task-B',
  agents: [makeAgent({ id: 'a-B', task_id: 'task-B', window_index: 0 })],
});

// Helper child that captures the real router-bound navigate so the test can
// drive navigation programmatically (mimicking a sidebar click).
let navigateHandle: ((path: string) => void) | null = null;
function NavCapture() {
  navigateHandle = useNavigate();
  return null;
}

describe('TaskDetail terminal LRU cache (cda6a35 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPerTaskUiState();
    eventCallbacks = new Set();
    navigateHandle = null;
    apiMock.getTask.mockImplementation((id: string) => {
      if (id === 'task-A') return Promise.resolve(taskA);
      if (id === 'task-B') return Promise.resolve(taskB);
      return Promise.reject(new Error(`unknown task ${id}`));
    });
  });

  it('keeps a TerminalView mounted when switching B→A where both tasks share activeWindow=0', async () => {
    render(
      <MemoryRouter initialEntries={['/tasks/task-A']}>
        <NavCapture />
        <Routes>
          <Route path="/tasks/:id" element={<TaskDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    // Task A loads, terminal mounts for window 0.
    await waitFor(() => {
      const t = screen.getByTestId('terminal-view');
      expect(t.getAttribute('data-task-id')).toBe('task-A');
      expect(t.getAttribute('data-window-index')).toBe('0');
    });

    // Navigate to Task B — both tasks have an agent at window_index 0,
    // so activeWindow stays 0 across the switch (the bug trigger).
    act(() => navigateHandle!('/tasks/task-B'));

    await waitFor(() => {
      const t = screen.getByTestId('terminal-view');
      expect(t.getAttribute('data-task-id')).toBe('task-B');
      expect(t.getAttribute('data-window-index')).toBe('0');
    });

    // Switch back to Task A. Before the fix this left the LRU empty —
    // setActiveWindow(0) bailed (no change), the promote effect didn't fire,
    // and no TerminalView was rendered until the user clicked another tab.
    act(() => navigateHandle!('/tasks/task-A'));

    await waitFor(() => {
      const t = screen.getByTestId('terminal-view');
      expect(t.getAttribute('data-task-id')).toBe('task-A');
      expect(t.getAttribute('data-window-index')).toBe('0');
      expect(t.getAttribute('data-visible')).toBe('true');
    });
  });
});
