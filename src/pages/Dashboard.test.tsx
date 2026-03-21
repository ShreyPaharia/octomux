import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from './Dashboard';
import { renderWithRouter, makeTask, mockApi } from '../test-helpers';

const apiMock = mockApi();

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    isOpen: false,
    running: false,
    loading: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiMock.listTasks.mockResolvedValue([]);
    apiMock.deleteTask.mockResolvedValue(undefined);
  });

  // ─── Initial render ───────────────────────────────────────────────────────

  it('shows loading state initially', () => {
    apiMock.listTasks.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderWithRouter(<Dashboard />);
    // Loading state now shows skeleton cards instead of text
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders new task button', async () => {
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getAllByText('NEW TASK').length).toBeGreaterThan(0);
    });
  });

  // ─── Orchestrator command bar ────────────────────────────────────────────

  it('renders orchestrator command bar', async () => {
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
    });
  });

  // ─── Task list rendering ──────────────────────────────────────────────────

  it('shows empty state when no tasks', async () => {
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    });
  });

  it('renders task cards when tasks exist', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Task Alpha' }),
      makeTask({ id: 't2', title: 'Task Beta' }),
    ]);
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('Task Alpha')).toBeInTheDocument();
      expect(screen.getByText('Task Beta')).toBeInTheDocument();
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error message when listTasks fails', async () => {
    apiMock.listTasks.mockRejectedValue(new Error('Network error'));
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  // ─── Filter bar ─────────────────────────────────────────────────────────

  it('shows Open and Closed filter tabs', async () => {
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText(/^Open/)).toBeInTheDocument();
      expect(screen.getByText(/^Closed/)).toBeInTheDocument();
    });
  });

  it('defaults to Open filter', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Running Task', status: 'running' }),
      makeTask({ id: 't2', title: 'Closed Task', status: 'closed' }),
    ]);
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('Running Task')).toBeInTheDocument();
    });
    expect(screen.queryByText('Closed Task')).not.toBeInTheDocument();
  });

  it('switches to Closed filter on tab click', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Running Task', status: 'running' }),
      makeTask({ id: 't2', title: 'Closed Task', status: 'closed' }),
    ]);
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('Running Task')).toBeInTheDocument();
    });
    await user.click(screen.getByText(/^Closed/));
    await waitFor(() => {
      expect(screen.getByText('Closed Task')).toBeInTheDocument();
    });
    expect(screen.queryByText('Running Task')).not.toBeInTheDocument();
  });

  it('shows draft tasks in Backlog filter', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', title: 'Draft Task', status: 'draft' }),
    ]);
    renderWithRouter(<Dashboard />);
    // Default filter is 'open', so draft should NOT appear
    await waitFor(() => {
      expect(screen.getByText(/^Backlog/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Draft Task')).not.toBeInTheDocument();
    // Switch to backlog tab
    await user.click(screen.getByText(/^Backlog/));
    await waitFor(() => {
      expect(screen.getByText('Draft Task')).toBeInTheDocument();
    });
  });

  // ─── Close ───────────────────────────────────────────────────────────────

  it('calls updateTask to close when close button is clicked on running task', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([makeTask({ status: 'running' })]);
    renderWithRouter(<Dashboard />);

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
    renderWithRouter(<Dashboard />);

    // Switch to Closed filter to see closed tasks
    await waitFor(() => {
      expect(screen.getByText(/^Closed/)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/^Closed/));

    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });

    await user.click(screen.getByTitle('Delete task'));

    await waitFor(() => {
      expect(apiMock.deleteTask).toHaveBeenCalledWith('test-task-01');
    });
  });
});
