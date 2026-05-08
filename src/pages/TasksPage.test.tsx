import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TasksPage from './TasksPage';
import { renderWithRouter, makeTask } from '../test-helpers';
import { TasksProvider } from '../lib/tasks-context';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', () => ({
  api: apiProxy,
  adaptTask: (t: unknown) => t,
  adaptTasks: (ts: unknown[]) => ts,
}));

vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
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

describe('TasksPage (board layout)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMock.listTasks.mockResolvedValue([]);
    apiMock.deleteTask.mockResolvedValue(undefined);
    apiMock.moveTask.mockResolvedValue(makeTask());
  });

  // ─── Initial render ───────────────────────────────────────────────────────

  it('shows loading state initially', () => {
    apiMock.listTasks.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderDashboard();
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

  // ─── Board columns ────────────────────────────────────────────────────────

  it('renders all 6 board columns', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('board-column-backlog')).toBeInTheDocument();
    });
    expect(screen.getByTestId('board-column-planned')).toBeInTheDocument();
    expect(screen.getByTestId('board-column-in_progress')).toBeInTheDocument();
    expect(screen.getByTestId('board-column-human_review')).toBeInTheDocument();
    expect(screen.getByTestId('board-column-pr')).toBeInTheDocument();
    expect(screen.getByTestId('board-column-done')).toBeInTheDocument();
  });

  it('shows empty placeholder in each column when no tasks', async () => {
    renderDashboard();
    await waitFor(() => {
      const empties = screen.getAllByText('Empty');
      expect(empties.length).toBeGreaterThanOrEqual(6);
    });
  });

  // ─── Task cards rendering ──────────────────────────────────────────────────

  it('renders task cards in the appropriate column', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Backlog Task', workflow_status: 'backlog' }),
      makeTask({ id: 't2', title: 'In Progress Task', workflow_status: 'in_progress' }),
    ]);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Backlog Task')).toBeInTheDocument();
      expect(screen.getByText('In Progress Task')).toBeInTheDocument();
    });
    // Verify they're in the correct columns
    const backlogCol = screen.getByTestId('board-column-backlog');
    const inProgressCol = screen.getByTestId('board-column-in_progress');
    expect(backlogCol).toHaveTextContent('Backlog Task');
    expect(inProgressCol).toHaveTextContent('In Progress Task');
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error message when listTasks fails', async () => {
    apiMock.listTasks.mockRejectedValue(new Error('Network error'));
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  // ─── Board filter bar ─────────────────────────────────────────────────────

  it('renders the board filter bar with needs attention toggle and search', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('board-filter-bar')).toBeInTheDocument();
    });
    expect(screen.getByTestId('filter-needs-attention')).toBeInTheDocument();
    expect(screen.getByTestId('board-search')).toBeInTheDocument();
  });

  it('filters to human_review and error tasks when needs attention is toggled', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: 't1',
        title: 'Normal Task',
        workflow_status: 'in_progress',
        runtime_state: 'running',
      }),
      makeTask({
        id: 't2',
        title: 'Review Task',
        workflow_status: 'human_review',
        runtime_state: 'idle',
      }),
      makeTask({
        id: 't3',
        title: 'Error Task',
        workflow_status: 'backlog',
        runtime_state: 'error',
      }),
    ]);
    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Normal Task')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('filter-needs-attention'));

    await waitFor(() => {
      expect(screen.queryByText('Normal Task')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Review Task')).toBeInTheDocument();
    expect(screen.getByText('Error Task')).toBeInTheDocument();
  });

  it('filters tasks by search text', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Fix login bug' }),
      makeTask({ id: 't2', title: 'Add dashboard' }),
    ]);
    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    });

    await user.type(screen.getByTestId('board-search'), 'login');

    await waitFor(() => {
      expect(screen.queryByText('Add dashboard')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  // ─── Board card navigation ────────────────────────────────────────────────

  it('navigates to task detail when card is clicked', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 'click-task', title: 'Clickable Task', workflow_status: 'backlog' }),
    ]);
    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Clickable Task')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Clickable Task'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/click-task');
  });
});
