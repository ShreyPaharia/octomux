import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksProvider } from '@/lib/tasks-context';
import { CommandPalette } from './CommandPalette';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

const mockTasksRef = { current: [] as Task[] };
vi.mock('@/lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderPalette(tasks: Task[]) {
  mockTasksRef.current = tasks;
  return render(
    <MemoryRouter>
      <TasksProvider>
        <CommandPalette />
      </TasksProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockTasksRef.current = [];
  apiMock.listTasks.mockResolvedValue([]);
});

describe('CommandPalette (inline search)', () => {
  const tasks: Task[] = [
    makeTask({ id: 't1', title: 'Authentication rewrite', repo_path: '/u/dev/octo' }),
    makeTask({ id: 't2', title: 'Billing fix', repo_path: '/u/dev/pay' }),
    makeTask({
      id: 't3',
      title: 'Auth telemetry',
      repo_path: '/u/dev/octo',
      status: 'setting_up',
    }),
    makeTask({ id: 't-closed', title: 'Closed one', status: 'closed' }),
  ];

  it('renders a search input that is always visible', () => {
    renderPalette(tasks);
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument();
  });

  it('does not render any results list when the query is empty', () => {
    renderPalette(tasks);
    expect(screen.queryByTestId('command-palette-results')).not.toBeInTheDocument();
  });

  it('typing shows filtered results inline', async () => {
    const user = userEvent.setup();
    renderPalette(tasks);
    await user.type(screen.getByTestId('command-palette-input'), 'auth');
    expect(screen.getByTestId('command-palette-result-t1')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-result-t3')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette-result-t2')).not.toBeInTheDocument();
    // closed tasks are excluded
    expect(screen.queryByTestId('command-palette-result-t-closed')).not.toBeInTheDocument();
  });

  it('clicking a session result navigates to /tasks/<id>', async () => {
    const user = userEvent.setup();
    renderPalette(tasks);
    await user.type(screen.getByTestId('command-palette-input'), 'Billing');
    // onMouseDown fires the navigation
    const row = screen.getByTestId('command-palette-result-t2');
    await user.pointer([{ keys: '[MouseLeft>]', target: row }, { keys: '[/MouseLeft]' }]);
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/t2');
  });

  it('Arrow keys navigate and Enter selects → navigate', async () => {
    const user = userEvent.setup();
    renderPalette(tasks);
    const input = screen.getByTestId('command-palette-input');
    await user.type(input, 'auth');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toMatch(/^\/tasks\//);
  });

  it('renders escape-hatch CTA when query has no matches', async () => {
    const user = userEvent.setup();
    renderPalette([]);
    await user.type(screen.getByTestId('command-palette-input'), 'brand new thing');
    const escape = await screen.findByTestId('command-palette-escape');
    expect(escape).toBeInTheDocument();
    expect(escape.textContent).toContain("'brand new thing'");
    expect(screen.getByTestId('command-palette-no-results')).toHaveTextContent(/no matches/i);
  });

  it('Enter on escape-hatch navigates to composer with prefill', async () => {
    const user = userEvent.setup();
    const focusSpy = vi.fn();
    window.addEventListener('focus-composer', focusSpy);
    try {
      renderPalette([]);
      const input = screen.getByTestId('command-palette-input');
      await user.type(input, 'fresh task');
      await user.keyboard('{Enter}');
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
      expect(focusSpy).toHaveBeenCalled();
      const call = focusSpy.mock.calls[0][0] as CustomEvent<{ prefill: string }>;
      expect(call.detail?.prefill).toBe('fresh task');
    } finally {
      window.removeEventListener('focus-composer', focusSpy);
    }
  });

  it('shows the New task action when query matches', async () => {
    const user = userEvent.setup();
    renderPalette([]);
    await user.type(screen.getByTestId('command-palette-input'), 'new');
    expect(screen.getByTestId('command-palette-action-new-task')).toBeInTheDocument();
  });
});
