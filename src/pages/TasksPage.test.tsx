import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TasksPage from './TasksPage';
import { renderWithRouter, makeTask } from '../test-helpers';
import { TasksProvider } from '../lib/tasks-context';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({ api: apiProxy }));

vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderDashboard() {
  return renderWithRouter(
    <TasksProvider>
      <TasksPage />
    </TasksProvider>,
  );
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMock.listTasks.mockResolvedValue([]);
    apiMock.deleteTask.mockResolvedValue(undefined);
  });

  // ─── Initial render ───────────────────────────────────────────────────────

  it('shows loading state initially', () => {
    apiMock.listTasks.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderDashboard();
    // Loading state now shows skeleton cards instead of text
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders new task button', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getAllByText('NEW TASK').length).toBeGreaterThan(0);
    });
  });

  // ─── Header ────────────────────────────────────────────────────────────────

  it('renders Command center heading with // TASKS eyebrow', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Command center')).toBeInTheDocument();
    });
    expect(screen.getByTestId('page-eyebrow')).toHaveTextContent('// TASKS');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-[32px]');
  });

  // ─── Task list rendering ──────────────────────────────────────────────────

  it('shows empty state when no tasks', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    });
  });

  it('renders task cards when tasks exist', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Task Alpha' }),
      makeTask({ id: 't2', title: 'Task Beta' }),
    ]);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Task Alpha')).toBeInTheDocument();
      expect(screen.getByText('Task Beta')).toBeInTheDocument();
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error message when listTasks fails', async () => {
    apiMock.listTasks.mockRejectedValue(new Error('Network error'));
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  // ─── Filter bar ─────────────────────────────────────────────────────────

  it('shows All, Running, Needs You, Closed filter chips', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('filter-chip-all')).toBeInTheDocument();
    });
    expect(screen.getByTestId('filter-chip-running')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-needs_you')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-closed')).toBeInTheDocument();
  });

  it('defaults to All filter and shows all statuses', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Running Task', status: 'running' }),
      makeTask({ id: 't2', title: 'Closed Task', status: 'closed' }),
    ]);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Running Task')).toBeInTheDocument();
    });
    expect(screen.getByText('Closed Task')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-all')).toHaveAttribute('data-active', 'true');
  });

  it('switches to Closed filter on chip click', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Running Task', status: 'running' }),
      makeTask({ id: 't2', title: 'Closed Task', status: 'closed' }),
    ]);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Running Task')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('filter-chip-closed'));
    await waitFor(() => {
      expect(screen.queryByText('Running Task')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Closed Task')).toBeInTheDocument();
  });

  it('shows errored tasks in Needs You filter', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Errored Task', status: 'error' }),
      makeTask({ id: 't2', title: 'Running Task', status: 'running' }),
    ]);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Errored Task')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('filter-chip-needs_you'));
    await waitFor(() => {
      expect(screen.queryByText('Running Task')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Errored Task')).toBeInTheDocument();
  });

  // ─── Close ───────────────────────────────────────────────────────────────

  it('calls updateTask to close when close button is clicked on running task', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([makeTask({ status: 'running' })]);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });

    await user.click(screen.getByTitle('Close task'));

    await waitFor(() => {
      expect(apiMock.updateTask).toHaveBeenCalledWith('test-task-01', { status: 'closed' });
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  it('calls deleteTask when delete button is clicked on closed task', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([makeTask({ status: 'closed' })]);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });

    await user.click(screen.getByTitle('Delete task'));

    await waitFor(() => {
      expect(apiMock.deleteTask).toHaveBeenCalledWith('test-task-01');
    });
  });
});
