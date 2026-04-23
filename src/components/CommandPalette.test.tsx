import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

function renderPalette(tasks: Task[], props: { open?: boolean } = {}) {
  mockTasksRef.current = tasks;
  const onClose = vi.fn();
  const utils = render(
    <MemoryRouter>
      <TasksProvider>
        <CommandPalette open={props.open ?? true} onClose={onClose} />
      </TasksProvider>
    </MemoryRouter>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockTasksRef.current = [];
  apiMock.listTasks.mockResolvedValue([]);
});

describe('CommandPalette', () => {
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

  it('renders role="dialog" with aria-modal when open', () => {
    renderPalette(tasks);
    const dialog = screen.getByRole('dialog', { name: /command palette/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('renders all open sessions (excludes closed/draft) when query is empty', () => {
    renderPalette(tasks);
    expect(screen.getByTestId('command-palette-result-t1')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-result-t2')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-result-t3')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette-result-t-closed')).not.toBeInTheDocument();
  });

  it('typing filters results', async () => {
    const user = userEvent.setup();
    renderPalette(tasks);
    await user.type(screen.getByTestId('command-palette-input'), 'auth');
    expect(screen.getByTestId('command-palette-result-t1')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-result-t3')).toBeInTheDocument();
    expect(screen.queryByTestId('command-palette-result-t2')).not.toBeInTheDocument();
  });

  it('Arrow keys navigate and Enter selects → navigate + focus-terminal event', async () => {
    const user = userEvent.setup();
    const focusSpy = vi.fn();
    window.addEventListener('focus-terminal', focusSpy);
    const { onClose } = renderPalette(tasks);
    const input = screen.getByTestId('command-palette-input');
    input.focus();
    // default active = 0 (first result). Move down once then select.
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    // navigate fires with /tasks/<second-result-id>
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toMatch(/^\/tasks\//);
    expect(onClose).toHaveBeenCalled();

    // focus-terminal dispatched on rAF — flush it
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(focusSpy).toHaveBeenCalled();
    window.removeEventListener('focus-terminal', focusSpy);
  });

  it('Escape closes without selecting', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette(tasks);
    screen.getByTestId('command-palette-input').focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking backdrop closes', () => {
    const { onClose } = renderPalette(tasks);
    fireEvent.click(screen.getByTestId('command-palette-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking inside dialog does not close', () => {
    const { onClose } = renderPalette(tasks);
    fireEvent.click(screen.getByTestId('command-palette'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    renderPalette(tasks, { open: false });
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });
});
