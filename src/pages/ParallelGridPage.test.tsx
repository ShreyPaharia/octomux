import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksProvider } from '@/lib/tasks-context';
import ParallelGridPage from './ParallelGridPage';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

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

function renderGrid(tasks: Task[]) {
  mockTasksRef.current = tasks;
  return render(
    <MemoryRouter>
      <TasksProvider>
        <ParallelGridPage />
      </TasksProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  apiMock.listTasks.mockResolvedValue([]);
});

describe('ParallelGridPage', () => {
  it('renders a pane per running task', () => {
    renderGrid([
      makeTask({ id: 'a', title: 'one', status: 'running', branch: 'agents/one' }),
      makeTask({ id: 'b', title: 'two', status: 'running', branch: 'agents/two' }),
    ]);
    expect(screen.getByTestId('grid-pane-a')).toBeInTheDocument();
    expect(screen.getByTestId('grid-pane-b')).toBeInTheDocument();
  });

  it('clicking a pane navigates to the task detail', async () => {
    const user = userEvent.setup();
    renderGrid([makeTask({ id: 'x', title: 'foo', status: 'running' })]);
    await user.click(screen.getByTestId('grid-pane-x'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/x');
  });

  it('shows empty state when there are no active agents', () => {
    renderGrid([]);
    expect(screen.getByText(/no active agents/i)).toBeInTheDocument();
  });
});
