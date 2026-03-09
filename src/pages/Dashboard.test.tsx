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

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTasks.mockResolvedValue([]);
    apiMock.deleteTask.mockResolvedValue(undefined);
  });

  // ─── Initial render ───────────────────────────────────────────────────────

  it('shows loading state initially', () => {
    apiMock.listTasks.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithRouter(<Dashboard />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders header and new task button', async () => {
    renderWithRouter(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('octomux-agents')).toBeInTheDocument();
    });
    expect(screen.getByText('New Task')).toBeInTheDocument();
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
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  it('calls deleteTask when delete button is clicked', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([makeTask()]);
    renderWithRouter(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('Fix order validation')).toBeInTheDocument();
    });

    // Click the delete button (last button in the card)
    const buttons = screen.getAllByRole('button');
    const deleteBtn = buttons.find(
      (btn) => btn.querySelector('svg') && !btn.textContent?.includes('New Task'),
    );
    if (deleteBtn) await user.click(deleteBtn);

    await waitFor(() => {
      expect(apiMock.deleteTask).toHaveBeenCalledWith('test-task-01');
    });
  });
});
