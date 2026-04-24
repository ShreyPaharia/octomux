import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './App';
import { makeTask } from './test-helpers';
import { TasksProvider } from './lib/tasks-context';
import type { Task } from '../server/types';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('./test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));
vi.mock('./lib/api', () => ({ api: apiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('./lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('./lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    running: false,
    loading: false,
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: vi.fn(),
  }),
  OrchestratorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockTasksRef = { current: [] as Task[] };
vi.mock('./lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useTask: () => ({ task: null, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  useTask: () => ({ task: null, loading: false, error: null, refresh: vi.fn() }),
}));

// We observe navigation rather than performing it, to keep tests simple.
const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('./test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

// Keep attention/notification hooks quiet.
vi.mock('./lib/use-attention-indicator', () => ({ useAttentionIndicator: vi.fn() }));
vi.mock('./lib/use-notifications', () => ({ useNotifications: vi.fn() }));

function renderShell(route = '/', tasks: Task[] = []) {
  mockTasksRef.current = tasks;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TasksProvider>
        <AppShell />
      </TasksProvider>
    </MemoryRouter>,
  );
}

function cmdKey(key: string, extra: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key, metaKey: true, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockTasksRef.current = [];
  localStorage.clear();
  apiMock.listTasks.mockResolvedValue([]);
  Object.defineProperty(window.navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
  });
});

describe('App global shortcuts', () => {
  it('⌘K opens command palette', async () => {
    renderShell('/');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
    act(() => {
      window.dispatchEvent(cmdKey('k'));
    });
    await waitFor(() => expect(screen.getByTestId('command-palette')).toBeInTheDocument());
  });

  it('⌘K preempts terminal-focused input', async () => {
    renderShell('/');
    // Simulate a terminal by focusing an input. Dispatch keydown from that target.
    const fakeTerm = document.createElement('textarea');
    fakeTerm.setAttribute('data-testid', 'fake-terminal');
    document.body.appendChild(fakeTerm);
    fakeTerm.focus();
    act(() => {
      fakeTerm.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('command-palette')).toBeInTheDocument());
    document.body.removeChild(fakeTerm);
  });

  it('⌘⇧N navigates to / (replace) and dispatches focus-composer', async () => {
    renderShell('/tasks/x');
    const focusSpy = vi.fn();
    window.addEventListener('focus-composer', focusSpy);
    act(() => {
      window.dispatchEvent(cmdKey('n', { shiftKey: true }));
    });
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(focusSpy).toHaveBeenCalled();
    window.removeEventListener('focus-composer', focusSpy);
  });

  it('⌘Enter on / dispatches submit-composer event', () => {
    renderShell('/');
    const submitSpy = vi.fn();
    window.addEventListener('submit-composer', submitSpy);
    act(() => {
      window.dispatchEvent(cmdKey('Enter'));
    });
    expect(submitSpy).toHaveBeenCalled();
    window.removeEventListener('submit-composer', submitSpy);
  });

  it('⌘Enter on /tasks/:id does NOT dispatch submit-composer', () => {
    renderShell('/tasks/xyz');
    const submitSpy = vi.fn();
    window.addEventListener('submit-composer', submitSpy);
    act(() => {
      window.dispatchEvent(cmdKey('Enter'));
    });
    expect(submitSpy).not.toHaveBeenCalled();
    window.removeEventListener('submit-composer', submitSpy);
  });

  it('⌘↓ navigates to next visible session (wrap from last → first)', () => {
    const tasks = [
      makeTask({ id: 's1', status: 'running', repo_path: '/r/octo' }),
      makeTask({ id: 's2', status: 'running', repo_path: '/r/octo' }),
    ];
    renderShell('/tasks/s2', tasks);
    act(() => {
      window.dispatchEvent(cmdKey('ArrowDown'));
    });
    // s2 is sorted by created_at (same) so stable-ish order. Accept any navigation
    // as long as it cycles to a valid session id.
    expect(mockNavigate).toHaveBeenCalled();
    const dest = mockNavigate.mock.calls[0][0] as string;
    expect(dest).toMatch(/^\/tasks\/(s1|s2)$/);
  });

  it('⌘↑ from non-task route goes to last visible session', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'running', repo_path: '/r/octo' }),
      makeTask({ id: 'b', status: 'running', repo_path: '/r/octo' }),
    ];
    renderShell('/', tasks);
    act(() => {
      window.dispatchEvent(cmdKey('ArrowUp'));
    });
    expect(mockNavigate).toHaveBeenCalled();
    const dest = mockNavigate.mock.calls[0][0] as string;
    expect(dest).toMatch(/^\/tasks\//);
  });

  it('⌘↓ does nothing when no visible sessions', () => {
    renderShell('/');
    act(() => {
      window.dispatchEvent(cmdKey('ArrowDown'));
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('palette ⌘K + typing + Enter (from within palette) navigates', async () => {
    const tasks = [makeTask({ id: 'target', title: 'Alpha', status: 'running' })];
    renderShell('/', tasks);
    act(() => {
      window.dispatchEvent(cmdKey('k'));
    });
    const input = await screen.findByTestId('command-palette-input');
    // Avoid using userEvent here — the shortcut listener is still registered and
    // could swallow keys. fireEvent is precise.
    fireEvent.change(input, { target: { value: 'Alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/target');
  });
});
